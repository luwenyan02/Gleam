package com.gleam.shiguang;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;
import okio.Okio;
import org.junit.Test;

public class GleamAiStreamSessionTest {
    private static final String URL = "https://model.example.invalid:9443/custom/chat/completions";
    private static Request request() { return GleamAiStreamSession.request(URL, "Bearer synthetic-key", "{\"stream\":true}"); }
    private static Response response(InputStream input) {
        return new Response.Builder().request(request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
            .body(new ResponseBody() {
                private final BufferedSource source = Okio.buffer(Okio.source(input));
                @Override public MediaType contentType() { return MediaType.get("text/event-stream"); }
                @Override public long contentLength() { return -1; }
                @Override public BufferedSource source() { return source; }
            }).build();
    }
    private static GleamAiStreamSession session(InputStream input) {
        GleamAiStreamSession session = new GleamAiStreamSession(GleamAiStreamSession.client().newCall(request()));
        assertTrue(session.attach(response(input))); return session;
    }

    @Test public void preservesRawSseNewlinesUtf8AndReturnsBeforeEof() throws Exception {
        byte[] bytes = "data: 首字\r\n\r\ndata: [DONE]\n\n".getBytes(StandardCharsets.UTF_8);
        AtomicInteger reads = new AtomicInteger();
        GleamAiStreamSession session = session(new ByteArrayInputStream(bytes) {
            @Override public synchronized int read(byte[] buffer, int offset, int length) {
                reads.incrementAndGet(); return super.read(buffer, offset, Math.min(length, 1));
            }
        });
        assertEquals(1, session.read().length);
        assertEquals(1, reads.get()); assertFalse(session.closed());
        ByteArrayOutputStream tail = new ByteArrayOutputStream(); tail.write(bytes[0]);
        byte[] chunk; while ((chunk = session.read()) != null) tail.write(chunk);
        assertArrayEquals(bytes, tail.toByteArray()); assertEquals("EOF", session.reason());
    }

    @Test public void returnsAtMostOneEightKiBChunkPerPull() throws Exception {
        GleamAiStreamSession session = session(new ByteArrayInputStream(new byte[20000]));
        assertEquals(8192, session.read().length); assertEquals(8192, session.read().length);
        assertEquals(3616, session.read().length); assertNull(session.read());
    }

    @Test public void cancellationClosesAndUnblocksPendingReadWithoutAcceptingLateBytes() throws Exception {
        CountDownLatch reading = new CountDownLatch(1), released = new CountDownLatch(1); AtomicInteger closed = new AtomicInteger();
        InputStream input = new InputStream() {
            @Override public int read() throws IOException { return read(new byte[1], 0, 1); }
            @Override public int read(byte[] bytes, int offset, int count) throws IOException {
                reading.countDown(); try { released.await(); } catch (InterruptedException interrupted) { throw new IOException(); }
                bytes[offset] = 42; return 1;
            }
            @Override public void close() { closed.incrementAndGet(); released.countDown(); }
        };
        Call call = GleamAiStreamSession.client().newCall(request());
        GleamAiStreamSession session = new GleamAiStreamSession(call); session.attach(response(input));
        ExecutorService io = Executors.newSingleThreadExecutor();
        try {
            Future<?> pending = io.submit(() -> { try { session.read(); fail("cancelled bytes accepted"); } catch (IOException expected) {} });
            assertTrue(reading.await(1, TimeUnit.SECONDS)); session.close("ABORTED");
            pending.get(1, TimeUnit.SECONDS); session.close("ABORTED");
            assertTrue(call.isCanceled()); assertEquals(1, closed.get()); assertEquals("ABORTED", session.reason());
        } finally { released.countDown(); io.shutdownNow(); }
    }

    @Test public void cancelledSessionImmediatelyClosesLateResponse() {
        AtomicInteger closed = new AtomicInteger();
        GleamAiStreamSession session = new GleamAiStreamSession(GleamAiStreamSession.client().newCall(request()));
        session.close("ABORTED");
        assertFalse(session.attach(response(new ByteArrayInputStream(new byte[0]) { @Override public void close() { closed.incrementAndGet(); } })));
        assertEquals(1, closed.get());
    }

    @Test public void responseLimitFailsAndClosesInsteadOfBufferingUnboundedData() throws Exception {
        GleamAiStreamSession session = session(new ByteArrayInputStream(new byte[GleamAiStreamSession.MAX_RESPONSE_BYTES + 1]));
        try { while (session.read() != null) {} fail("oversized body accepted"); }
        catch (IOException expected) { assertTrue(session.closed()); }
    }

    @Test public void timeoutOwnershipClosesDormantStreamWithoutAnotherRead() throws Exception {
        AtomicInteger closed = new AtomicInteger();
        CountDownLatch released = new CountDownLatch(1);
        GleamAiStreamSession session = session(new ByteArrayInputStream(new byte[100]) { @Override public void close() { closed.incrementAndGet(); released.countDown(); } });
        java.util.concurrent.ScheduledExecutorService clock = Executors.newSingleThreadScheduledExecutor();
        try {
            session.deadline(clock.schedule(() -> session.close("TIMEOUT"), 10, TimeUnit.MILLISECONDS));
            assertTrue(released.await(1, TimeUnit.SECONDS));
            assertTrue(session.closed()); assertEquals("TIMEOUT", session.reason()); assertEquals(1, closed.get());
        } finally { clock.shutdownNow(); }
    }

    @Test public void preservesCustomHttpsPostJsonAndBearerWithoutFollowingRedirectsOrRetries() throws Exception {
        Request request = request(); okio.Buffer body = new okio.Buffer(); request.body().writeTo(body);
        assertEquals("POST", request.method()); assertEquals(URL, request.url().toString());
        assertEquals("{\"stream\":true}", body.readUtf8()); assertEquals("Bearer synthetic-key", request.header("Authorization"));
        assertEquals("text/event-stream", request.header("Accept"));
        assertFalse(GleamAiStreamSession.client().followRedirects()); assertFalse(GleamAiStreamSession.client().followSslRedirects());
        assertFalse(GleamAiStreamSession.client().retryOnConnectionFailure());
        assertEquals(120000, GleamAiStreamSession.client().callTimeoutMillis());
    }

    @Test public void originalNinePhotoBoundaryIsNotReducedToSmallStreamBufferLimit() {
        assertTrue(GleamAiStreamSession.MAX_REQUEST_CHARS > 9L * 15_000_000);
        assertTrue(GleamAiStreamSession.MAX_REQUEST_BYTES > 9L * 15_000_000 + 100_000);
    }

    @Test public void rejectsUnsafeDestinationsOrHeaderInjection() {
        for (String url : new String[] {"http://model.example.invalid/v1/chat/completions", "https://user:secret@example.invalid/v1/chat/completions", "https://example.invalid/v1#fragment"}) {
            try { GleamAiStreamSession.request(url, "Bearer synthetic-key", "{}"); fail("unsafe URL accepted"); } catch (IllegalArgumentException expected) {}
        }
        try { GleamAiStreamSession.request(URL, "Bearer synthetic-key\r\nOther: value", "{}"); fail("header injection accepted"); } catch (IllegalArgumentException expected) {}
    }
}
