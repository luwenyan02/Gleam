package com.gleam.shiguang;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLException;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 只服务于拾光 WebDAV 备份的窄原生通道。
 *
 * CapacitorHttp 的 Android HttpURLConnection 不支持 MKCOL/PROPFIND，因此这里用
 * OkHttp 发送受限方法集。不记录 URL、Authorization、正文或底层异常消息。
 */
@CapacitorPlugin(name = "GleamWebDav")
public final class GleamWebDavPlugin extends Plugin {
    static final int MAX_BODY_BYTES = 50 * 1024 * 1024;
    static final int MAX_ENCODED_BODY_CHARS = ((MAX_BODY_BYTES + 2) / 3) * 4;
    private static final Set<String> ALLOWED_METHODS = new HashSet<>(Arrays.asList("PROPFIND", "MKCOL", "GET", "PUT", "DELETE"));
    private static final String SAFE_ABORTED = "WebDAV 请求已取消";
    private static final String SAFE_TIMEOUT = "WebDAV 请求超时";
    private static final String SAFE_NETWORK = "WebDAV 网络请求失败";
    private static final String SAFE_TLS = "WebDAV TLS 连接失败";
    private static final String SAFE_INVALID = "WebDAV 请求配置无效";
    private static final String SAFE_TOO_LARGE = "WebDAV 数据超过 50 MB 上限";

    private final OkHttpClient client = createClient();
    private final ConcurrentHashMap<String, Call> activeCalls = new ConcurrentHashMap<>();

    static OkHttpClient createClient() {
        return new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .retryOnConnectionFailure(false)
            .build();
    }

    static void validateEncodedBodyLength(int length) {
        if (length < 0 || length > MAX_ENCODED_BODY_CHARS) throw new IllegalArgumentException(SAFE_TOO_LARGE);
    }

    private static byte[] decodeBody(String bodyBase64) {
        if (bodyBase64 == null) return null;
        validateEncodedBodyLength(bodyBase64.length());
        byte[] body;
        try {
            body = Base64.decode(bodyBase64, Base64.NO_WRAP);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(SAFE_INVALID);
        }
        if (body.length > MAX_BODY_BYTES) throw new IllegalArgumentException(SAFE_TOO_LARGE);
        return body;
    }

    static Request buildRequest(
        String url,
        String method,
        String authorization,
        String depth,
        String contentType,
        byte[] body
    ) {
        if (url == null || method == null || authorization == null) throw new IllegalArgumentException(SAFE_INVALID);
        final URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(SAFE_INVALID);
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException(SAFE_INVALID);
        }

        String upperMethod = method.toUpperCase(Locale.ROOT);
        if (!ALLOWED_METHODS.contains(upperMethod)) throw new IllegalArgumentException(SAFE_INVALID);
        if (!authorization.startsWith("Basic ") || authorization.length() > 8192 || authorization.indexOf('\n') >= 0 || authorization.indexOf('\r') >= 0) {
            throw new IllegalArgumentException(SAFE_INVALID);
        }
        if (depth != null && !("0".equals(depth) || "1".equals(depth))) throw new IllegalArgumentException(SAFE_INVALID);

        boolean methodNeedsBody = "PROPFIND".equals(upperMethod) || "PUT".equals(upperMethod);
        boolean methodForbidsBody = "GET".equals(upperMethod) || "DELETE".equals(upperMethod) || "MKCOL".equals(upperMethod);
        if (methodNeedsBody && body == null) body = new byte[0];
        if (methodForbidsBody && body != null) throw new IllegalArgumentException(SAFE_INVALID);

        MediaType mediaType = contentType == null || contentType.trim().isEmpty() ? null : MediaType.parse(contentType);
        RequestBody requestBody = body == null ? null : RequestBody.create(body, mediaType);
        Request.Builder builder = new Request.Builder()
            .url(url)
            .header("Authorization", authorization)
            .method(upperMethod, requestBody);
        if (depth != null) builder.header("Depth", depth);
        if (contentType != null && !contentType.trim().isEmpty()) builder.header("Content-Type", contentType);
        return builder.build();
    }

    private static byte[] readBounded(ResponseBody body) throws IOException {
        if (body == null) return new byte[0];
        long declared = body.contentLength();
        if (declared > MAX_BODY_BYTES) throw new BodyTooLargeException();
        try (InputStream input = body.byteStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_BODY_BYTES) throw new BodyTooLargeException();
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    @PluginMethod
    public void request(PluginCall pluginCall) {
        String id = pluginCall.getString("id");
        if (id == null || !id.matches("[A-Za-z0-9-]{8,80}")) {
            pluginCall.reject(SAFE_INVALID, "INVALID_REQUEST");
            return;
        }

        final Request request;
        try {
            request = buildRequest(
                pluginCall.getString("url"),
                pluginCall.getString("method"),
                pluginCall.getString("authorization"),
                pluginCall.getString("depth"),
                pluginCall.getString("contentType"),
                decodeBody(pluginCall.getString("bodyBase64"))
            );
        } catch (IllegalArgumentException error) {
            String code = SAFE_TOO_LARGE.equals(error.getMessage()) ? "BODY_TOO_LARGE" : "INVALID_REQUEST";
            pluginCall.reject(code.equals("BODY_TOO_LARGE") ? SAFE_TOO_LARGE : SAFE_INVALID, code);
            return;
        }

        Call call = client.newCall(request);
        activeCalls.put(id, call);
        call.enqueue(new Callback() {
            @Override
            public void onFailure(Call failedCall, IOException error) {
                activeCalls.remove(id, failedCall);
                if (failedCall.isCanceled()) pluginCall.reject(SAFE_ABORTED, "ABORTED");
                else if (error instanceof InterruptedIOException) pluginCall.reject(SAFE_TIMEOUT, "TIMEOUT");
                else if (error instanceof SSLException) pluginCall.reject(SAFE_TLS, "TLS");
                else pluginCall.reject(SAFE_NETWORK, "NETWORK");
            }

            @Override
            public void onResponse(Call completedCall, Response response) {
                try (response) {
                    byte[] responseBytes = response.isSuccessful() ? readBounded(response.body()) : new byte[0];
                    JSObject result = new JSObject();
                    result.put("status", response.code());
                    result.put("bodyBase64", Base64.encodeToString(responseBytes, Base64.NO_WRAP));
                    if (response.body() != null && response.body().contentType() != null) {
                        result.put("contentType", response.body().contentType().toString());
                    }
                    pluginCall.resolve(result);
                } catch (BodyTooLargeException error) {
                    pluginCall.reject(SAFE_TOO_LARGE, "BODY_TOO_LARGE");
                } catch (IOException error) {
                    if (completedCall.isCanceled()) pluginCall.reject(SAFE_ABORTED, "ABORTED");
                    else if (error instanceof InterruptedIOException) pluginCall.reject(SAFE_TIMEOUT, "TIMEOUT");
                    else pluginCall.reject(SAFE_NETWORK, "NETWORK");
                } finally {
                    activeCalls.remove(id, completedCall);
                }
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall pluginCall) {
        String id = pluginCall.getString("id");
        Call call = id == null ? null : activeCalls.remove(id);
        if (call != null) call.cancel();
        pluginCall.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Call call : activeCalls.values()) call.cancel();
        activeCalls.clear();
        super.handleOnDestroy();
    }

    private static final class BodyTooLargeException extends IOException {}
}
