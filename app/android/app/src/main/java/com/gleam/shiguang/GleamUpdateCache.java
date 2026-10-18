package com.gleam.shiguang;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.json.JSONObject;

/** Private cache only: persist verified release metadata, never credentials or download URLs. */
final class GleamUpdateCache {
    private final File directory;
    interface Validator { void verify(File file, GleamUpdateRelease release) throws Exception; }
    static final class Record {
        final GleamUpdateRelease release;
        final String hash;
        Record(GleamUpdateRelease release, String hash) { this.release=release; this.hash=hash; }
    }
    GleamUpdateCache(File directory) { this.directory=directory; }
    File apk() { return new File(directory,"update.apk"); }
    File part() { return new File(directory,"update.apk.part"); }
    private File metadata() { return new File(directory,"ready.json"); }
    private File staging() { return new File(directory,"ready.json.part"); }
    void clear() { apk().delete(); part().delete(); metadata().delete(); staging().delete(); }
    void commit(GleamUpdateRelease release, String hash) throws Exception {
        if (!apk().isFile() || apk().length()!=release.size || !hash.matches("[a-f0-9]{64}")) throw new IOException("invalid cache");
        byte[] value=new JSONObject().put("release",release.toJson()).put("sha256",hash).toString().getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream out=new FileOutputStream(staging())) { out.write(value); out.getFD().sync(); }
        if (!staging().renameTo(metadata())) throw new IOException("cache commit failed");
    }
    Record restore(long installedCode, Validator validator) {
        try {
            // A killed or cancelled transfer never becomes an installable package.
            part().delete(); staging().delete();
            if (!apk().isFile() || !metadata().isFile() || metadata().length()>65536) throw new IOException("incomplete cache");
            ByteArrayOutputStream out=new ByteArrayOutputStream();
            try (InputStream in=new FileInputStream(metadata())) {
                byte[] bytes=new byte[4096]; int n;
                while ((n=in.read(bytes))!=-1) { if (out.size()+n>65536) throw new IOException("metadata too large"); out.write(bytes,0,n); }
            }
            JSONObject json=new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));
            GleamUpdateRelease release=GleamUpdateRelease.parse(json.getJSONObject("release"),installedCode);
            String expected=json.getString("sha256");
            if (release==null || apk().length()!=release.size || !expected.matches("[a-f0-9]{64}")) throw new IOException("stale cache");
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            try (InputStream in=new FileInputStream(apk())) { byte[] bytes=new byte[32768]; int n; while ((n=in.read(bytes))!=-1) digest.update(bytes,0,n); }
            StringBuilder actual=new StringBuilder();
            for (byte b:digest.digest()) actual.append(String.format(java.util.Locale.ROOT,"%02x",b & 255));
            if (!expected.equals(actual.toString())) throw new IOException("cache checksum mismatch");
            validator.verify(apk(),release);
            return new Record(release,expected);
        } catch (Exception invalid) { clear(); return null; }
    }
}
