package com.gleam.shiguang;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.*;
import org.json.JSONObject;

/** Explicit user requests only; fixed public release repository; no credentials. */
@CapacitorPlugin(name="GleamUpdate")
public final class GleamUpdatePlugin extends Plugin {
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final OkHttpClient client=new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.MINUTES).build();
    private volatile Operation active;
    private volatile boolean destroyed;
    private GleamUpdateRelease candidate;
    private String downloadedHash;
    private static final class Failure extends Exception {
        final String code;
        Failure(String code) { this.code=code; }
    }
    private static final class Operation {
        final String id;
        final AtomicBoolean cancelled=new AtomicBoolean();
        volatile Call network;
        Operation(String id) { this.id=id; }
        void check() throws Failure { if (cancelled.get()) throw new Failure("CANCELLED"); }
        void cancel() { cancelled.set(true); Call call=network; if (call!=null) call.cancel(); }
    }
    private interface Task { JSObject run(Operation op) throws Exception; }
    private synchronized void submit(PluginCall call, Task task) {
        String id=call.getString("requestId");
        if (id==null || !id.matches("[A-Za-z0-9-]{8,80}")) { call.reject("更新请求无效", "INVALID"); return; }
        if (active!=null || destroyed) { call.reject("更新操作正在进行", "BUSY"); return; }
        Operation op=new Operation(id); active=op;
        worker.execute(() -> {
            try { JSObject result=task.run(op); op.check(); call.resolve(result); }
            catch (Exception error) {
                String code=op.cancelled.get() ? "CANCELLED" : error instanceof Failure ? ((Failure)error).code
                    : error instanceof InterruptedIOException ? "TIMEOUT" : error instanceof IOException ? "NETWORK" : "INVALID";
                call.reject("更新操作未完成", code);
            } finally { synchronized (GleamUpdatePlugin.this) { if (active==op) active=null; } }
        });
    }
    @PluginMethod public void configuration(PluginCall call) {
        // Remove the obsolete private-repository credential without decrypting it.
        // Cleanup failure must not block anonymous update checks.
        try { GleamSecretsPlugin.clearLegacyUpdateToken(getContext()); }
        catch (Exception ignored) {}
        call.resolve();
    }
    private PackageInfo installed() throws Exception { return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), signatureFlags()); }
    private long code(PackageInfo info) { return Build.VERSION.SDK_INT>=28 ? info.getLongVersionCode() : info.versionCode; }
    private int signatureFlags() { return Build.VERSION.SDK_INT>=28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES; }
    @PluginMethod public void check(PluginCall call) {
        submit(call, op -> {
            clearDownload(); candidate=null;
            JSONObject release=readJson(op);
            GleamUpdateRelease update;
            try { update=GleamUpdateRelease.parse(release, code(installed())); }
            catch (Exception error) { throw new Failure("RELEASE_INVALID"); }
            op.check(); candidate=update;
            JSObject result=new JSObject(); result.put("available", update!=null);
            if (update!=null) {
                result.put("releaseId", String.valueOf(update.id)); result.put("version", update.version);
                result.put("size", update.size); result.put("notes", update.notes);
            }
            return result;
        });
    }
    private JSONObject readJson(Operation op) throws Exception {
        try (Response response=open(op, GleamUpdateRelease.API+"/latest", false)) {
            return new JSONObject(new String(readBounded(response, 1024*1024), StandardCharsets.UTF_8));
        }
    }
    private Response open(Operation op, String initial, boolean asset) throws Exception {
        try {
            return GleamUpdateHttp.get(client, new GleamUpdateHttp.Guard() {
                public void check() throws Exception { op.check(); }
                public void track(Call call) { op.network=call; if (op.cancelled.get()) call.cancel(); }
            }, initial, asset);
        } catch (GleamUpdateHttp.Failure error) { throw new Failure(error.code); }
    }

    private static byte[] readBounded(Response response, int maximum) throws Exception {
        if (response.body().contentLength()>maximum) throw new Failure("RELEASE_INVALID");
        try (InputStream in=response.body().byteStream(); ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            byte[] buffer=new byte[8192]; int read;
            while ((read=in.read(buffer))!=-1) {
                if (out.size()+read>maximum) throw new Failure("RELEASE_INVALID");
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }
    private File apkFile() { return new File(getContext().getCacheDir(), "gleam-update/update.apk"); }
    private void clearDownload() { downloadedHash=null; apkFile().delete(); new File(apkFile().getPath()+".part").delete(); }
    private GleamUpdateRelease selected(PluginCall call) throws Failure {
        if (candidate==null || !String.valueOf(candidate.id).equals(call.getString("releaseId"))) throw new Failure("RECHECK");
        return candidate;
    }
    @PluginMethod public void download(PluginCall call) {
        submit(call, op -> {
            GleamUpdateRelease update=selected(call); clearDownload();
            String expected;
            try (Response response=open(op, GleamUpdateRelease.API+"/assets/"+update.checksumId, true)) {
                try { expected=GleamUpdateRelease.checksum(new String(readBounded(response, 1024), StandardCharsets.UTF_8), update.name); }
                catch (IllegalArgumentException error) { throw new Failure("CHECKSUM"); }
            }
            File target=apkFile(), part=new File(target.getPath()+".part");
            if (!target.getParentFile().isDirectory() && !target.getParentFile().mkdirs()) throw new Failure("STORAGE");
            boolean complete=false;
            try {
                MessageDigest digest=MessageDigest.getInstance("SHA-256"); long size=0;
                try (Response response=open(op, GleamUpdateRelease.API+"/assets/"+update.apkId, true);
                     InputStream in=response.body().byteStream(); FileOutputStream out=new FileOutputStream(part)) {
                    if (response.body().contentLength()>GleamUpdateRelease.MAX_APK) throw new Failure("CHECKSUM");
                    byte[] buffer=new byte[32768]; int read;
                    while ((read=in.read(buffer))!=-1) {
                        op.check(); size+=read;
                        if (size>update.size || size>GleamUpdateRelease.MAX_APK) throw new Failure("CHECKSUM");
                        digest.update(buffer, 0, read); out.write(buffer, 0, read);
                    }
                    out.getFD().sync();
                }
                if (size!=update.size || !hex(digest.digest()).equals(expected)) throw new Failure("CHECKSUM");
                verifyPackage(part, update);
                op.check();
                if (!part.renameTo(target)) throw new Failure("STORAGE");
                downloadedHash=expected; complete=true;
                return new JSObject();
            } finally { if (!complete) { part.delete(); target.delete(); downloadedHash=null; } }
        });
    }
    private static String hex(byte[] value) {
        StringBuilder out=new StringBuilder(); for (byte b:value) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return out.toString();
    }
    private String signer(PackageInfo info) throws Exception {
        Signature[] signatures=Build.VERSION.SDK_INT>=28 ? info.signingInfo==null ? null : info.signingInfo.getApkContentsSigners() : info.signatures;
        if (signatures==null || signatures.length!=1) throw new Failure("SIGNATURE");
        return hex(MessageDigest.getInstance("SHA-256").digest(signatures[0].toByteArray()));
    }
    private void verifyPackage(File file, GleamUpdateRelease update) throws Exception {
        PackageInfo archive=getContext().getPackageManager().getPackageArchiveInfo(file.getPath(), signatureFlags());
        PackageInfo current=installed();
        if (archive==null || !current.packageName.equals(archive.packageName) || code(archive)!=update.code
            || code(archive)<=code(current) || !update.version.equals(archive.versionName)) throw new Failure("PACKAGE");
        String certificate=signer(archive);
        if (!certificate.equals(signer(current)) || !certificate.equals("f979d49ce586a7438bcaf44bcec4b4edaa9e80cba170a07f8f8895b757380012")) throw new Failure("SIGNATURE");
    }
    @PluginMethod public void install(PluginCall call) {
        submit(call, op -> {
            GleamUpdateRelease update=selected(call); File apk=apkFile();
            if (downloadedHash==null || !apk.isFile()) throw new Failure("RECHECK");
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            try (InputStream in=new FileInputStream(apk)) { byte[] b=new byte[32768]; int n; while ((n=in.read(b))!=-1) { op.check(); digest.update(b,0,n); } }
            if (!hex(digest.digest()).equals(downloadedHash)) { clearDownload(); throw new Failure("CHECKSUM"); }
            verifyPackage(apk, update); op.check();
            CompletableFuture<JSObject> launched=new CompletableFuture<>();
            getActivity().runOnUiThread(() -> {
                try {
                    op.check();
                    boolean permission=Build.VERSION.SDK_INT>=26 && !getContext().getPackageManager().canRequestPackageInstalls();
                    Intent intent;
                    if (permission) intent=new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:"+getContext().getPackageName()));
                    else {
                        Uri uri=FileProvider.getUriForFile(getContext(), getContext().getPackageName()+".fileprovider", apk);
                        intent=new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    }
                    getActivity().startActivity(intent);
                    JSObject result=new JSObject(); result.put("permissionRequired", permission); launched.complete(result);
                } catch (Exception error) { launched.completeExceptionally(new Failure("INSTALL")); }
            });
            try { return launched.get(30, TimeUnit.SECONDS); }
            catch (Exception error) { op.cancel(); throw new Failure("INSTALL"); }
        });
    }
    @PluginMethod public void cancel(PluginCall call) {
        Operation op=active;
        if (op!=null && op.id.equals(call.getString("requestId"))) op.cancel();
        call.resolve();
    }
    @Override protected void handleOnDestroy() {
        destroyed=true; Operation op=active; if (op!=null) op.cancel(); worker.shutdown(); super.handleOnDestroy();
    }
}
