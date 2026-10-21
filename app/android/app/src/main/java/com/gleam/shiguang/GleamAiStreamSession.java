package com.gleam.shiguang;

import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ScheduledFuture;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** Raw-byte response ownership. The state lock never covers a blocking read. */
final class GleamAiStreamSession {
    static final int CHUNK_BYTES = 8192;
    static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    // Preserve the existing nine-photo (15M data-URL characters each) input boundary.
    static final int MAX_REQUEST_CHARS = 140_000_000;
    static final int MAX_REQUEST_BYTES = 144 * 1024 * 1024;
    static final long TIMEOUT_MS = 120_000;
    private final Call call;
    private Response response;
    private InputStream input;
    private int received;
    private boolean reading, closed;
    private String reason;
    private ScheduledFuture<?> deadline;

    GleamAiStreamSession(Call call) { this.call = call; }

    static OkHttpClient client() {
        return new OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS).readTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .callTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS).followRedirects(false)
            .followSslRedirects(false).retryOnConnectionFailure(false).build();
    }

    static Request request(String url, String authorization, String body) {
        if (url == null || authorization == null || body == null || body.length() > MAX_REQUEST_CHARS) throw new IllegalArgumentException();
        URI uri = URI.create(url);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getFragment() != null
            || !authorization.startsWith("Bearer ") || authorization.length() > 8192 || authorization.indexOf('\n') >= 0 || authorization.indexOf('\r') >= 0) {
            throw new IllegalArgumentException();
        }
        long byteLength = 0;
        for (int index = 0; index < body.length(); index++) {
            char value = body.charAt(index);
            if (value < 128) byteLength++;
            else if (value < 2048) byteLength += 2;
            else if (Character.isHighSurrogate(value) && index + 1 < body.length() && Character.isLowSurrogate(body.charAt(index + 1))) { byteLength += 4; index++; }
            else byteLength += 3;
            if (byteLength > MAX_REQUEST_BYTES) throw new IllegalArgumentException();
        }
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        return new Request.Builder().url(url).header("Authorization", authorization).header("Accept", "text/event-stream")
            .post(RequestBody.create(bytes, MediaType.get("application/json; charset=utf-8"))).build();
    }

    synchronized boolean attach(Response next) {
        if (closed) { try { next.close(); } catch (RuntimeException ignored) {} return false; }
        response = next;
        input = next.body() == null ? new ByteArrayInputStream(new byte[0]) : next.body().byteStream();
        return true;
    }

    byte[] read() throws IOException {
        final InputStream source;
        synchronized (this) {
            if (closed || input == null || reading) throw new IOException("STREAM_STATE");
            reading = true; source = input;
        }
        try {
            byte[] buffer = new byte[CHUNK_BYTES];
            int count;
            do { count = source.read(buffer); } while (count == 0);
            synchronized (this) {
                if (closed) throw new IOException("STREAM_CLOSED");
                if (count > 0 && (received += count) > MAX_RESPONSE_BYTES) throw new IOException("STREAM_TOO_LARGE");
            }
            if (count < 0) { close("EOF"); return null; }
            return Arrays.copyOf(buffer, count);
        } catch (IOException failure) {
            close("NETWORK"); throw failure;
        } finally { synchronized (this) { reading = false; } }
    }

    void close(String code) {
        final Response owned;
        final ScheduledFuture<?> timeout;
        synchronized (this) {
            if (closed) return;
            closed = true; reason = code; owned = response; response = null; input = null; timeout = deadline; deadline = null;
        }
        if (timeout != null) timeout.cancel(false);
        if (!"EOF".equals(code)) call.cancel();
        if (owned != null) { try { owned.close(); } catch (RuntimeException ignored) {} }
    }
    synchronized void deadline(ScheduledFuture<?> timeout) { if (closed) timeout.cancel(false); else deadline = timeout; }
    synchronized boolean closed() { return closed; }
    synchronized String reason() { return reason; }
}
