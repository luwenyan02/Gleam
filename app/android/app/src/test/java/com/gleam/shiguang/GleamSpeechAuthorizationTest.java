package com.gleam.shiguang;

import static org.junit.Assert.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** Uses the production operation gate and speech engine; synthetic operations never open mic/socket. */
public class GleamSpeechAuthorizationTest {
    static final class Authority {
        final Object lock = new Object();
        String revision = "revision-current";
        boolean foreground = true, destroyed, current = true;
        final GleamSpeechAuthorization access = new GleamSpeechAuthorization(lock,
            () -> current && foreground && !destroyed && "revision-current".equals(revision));
        void rotate() { synchronized (lock) { revision = "revision-next"; } }
    }
    @Test public void pcmSendRechecksRevisionAfterCaptureThreadAlreadyPassedItsPrecheck() {
        Authority authority = new Authority();
        GleamSpeechSessionTest.Fixture transport = new GleamSpeechSessionTest.Fixture() {
            @Override public boolean send(String value) { return authority.access.send(() -> super.send(value)); }
        };
        transport.ready(); assertEquals(1, transport.starts);
        assertTrue(authority.access.allowed()); // capture's earlier mayCapture check succeeded at R.
        authority.rotate(); // native main-key mutation completes at R2 before engine.audio/send.
        int previous = transport.sent.size(); transport.pcm();
        assertEquals(previous, transport.sent.size());
        assertFalse(transport.sent.stream().anyMatch(value -> value.contains("input_audio_buffer.append")));
        assertEquals(1, transport.stops); assertTrue(transport.session.isClosed());
    }
    @Test public void microphoneActivationRechecksAfterBothEarlierPrechecksPassed() {
        Authority authority = new Authority(); AtomicInteger starts = new AtomicInteger();
        assertTrue(authority.access.allowed()); assertTrue(authority.access.allowed());
        authority.rotate();
        try { authority.access.activate(starts::incrementAndGet); fail("a stale precheck cannot start the microphone"); }
        catch (IllegalStateException expected) { assertEquals("SPEECH_INTERRUPTED", expected.getMessage()); }
        assertEquals(0, starts.get());
    }
    @Test public void lifecycleRevocationAndNewerSessionDenyBothOperationTypes() {
        for (int reason = 0; reason < 3; reason++) {
            Authority authority = new Authority(); AtomicInteger calls = new AtomicInteger();
            synchronized (authority.lock) {
                if (reason == 0) authority.foreground = false;
                else if (reason == 1) authority.destroyed = true;
                else authority.current = false;
            }
            assertFalse(authority.access.send(() -> { calls.incrementAndGet(); return true; }));
            try { authority.access.activate(calls::incrementAndGet); fail("revoked activation"); }
            catch (IllegalStateException expected) {}
            assertEquals(0, calls.get());
        }
    }
    @Test public void nativeMainKeyCannotMutateBetweenOperationAuthorizationAndSocketSend() throws Exception {
        assertOperationAtomic(false);
    }
    @Test public void nativeMainKeyCannotMutateBetweenOperationAuthorizationAndMicrophoneActivation() throws Exception {
        assertOperationAtomic(true);
    }
    private void assertOperationAtomic(boolean microphone) throws Exception {
        Authority authority = new Authority();
        CountDownLatch inside = new CountDownLatch(1), release = new CountDownLatch(1), wantsMutation = new CountDownLatch(1);
        AtomicBoolean changed = new AtomicBoolean(); AtomicInteger operations = new AtomicInteger(); AtomicReference<Throwable> error = new AtomicReference<>();
        Runnable operation = () -> {
            inside.countDown();
            try { if (!release.await(5, TimeUnit.SECONDS)) throw new AssertionError("operation timeout"); }
            catch (InterruptedException interrupted) { throw new AssertionError(interrupted); }
            assertEquals("revision-current", authority.revision); operations.incrementAndGet();
        };
        Thread user = new Thread(() -> {
            try {
                if (microphone) authority.access.activate(operation);
                else assertTrue(authority.access.send(() -> { operation.run(); return true; }));
            } catch (Throwable failure) { error.set(failure); }
        });
        Thread mutation = new Thread(() -> { wantsMutation.countDown(); authority.rotate(); changed.set(true); });
        user.start(); assertTrue(inside.await(5, TimeUnit.SECONDS)); mutation.start(); assertTrue(wantsMutation.await(5, TimeUnit.SECONDS));
        assertFalse(changed.get()); release.countDown(); user.join(5000); mutation.join(5000);
        assertFalse(user.isAlive()); assertFalse(mutation.isAlive()); assertNull(error.get()); assertTrue(changed.get()); assertEquals(1, operations.get());
        assertFalse(authority.access.send(() -> { operations.incrementAndGet(); return true; }));
        try { authority.access.activate(operations::incrementAndGet); fail("post-revocation activation"); } catch (IllegalStateException expected) {}
        assertEquals(1, operations.get());
    }
    @Test public void revocationDoesNotWaitForEngineMonitorBeforeReleasingCredentialLock() throws Exception {
        Authority authority = new Authority(); Object engine = new Object();
        CountDownLatch engineHeld = new CountDownLatch(1), mutationComplete = new CountDownLatch(1);
        AtomicReference<Throwable> error = new AtomicReference<>(); AtomicInteger sends = new AtomicInteger();
        // Production engine.audio holds the engine monitor before reaching authorization.send.
        Thread capture = new Thread(() -> {
            synchronized (engine) {
                engineHeld.countDown();
                try {
                    if (!mutationComplete.await(5, TimeUnit.SECONDS)) throw new AssertionError("revocation waited for engine");
                    assertFalse(authority.access.send(() -> { sends.incrementAndGet(); return true; }));
                } catch (Throwable failure) { error.set(failure); }
            }
        });
        Thread mutation = new Thread(() -> {
            try {
                if (!engineHeld.await(5, TimeUnit.SECONDS)) throw new AssertionError("missing capture");
                // Same lock order as plugin: revoke/detach socket under credential lock, then release
                // it before queued engine.cancel can acquire the engine monitor.
                authority.rotate(); mutationComplete.countDown(); synchronized (engine) {}
            } catch (Throwable failure) { error.set(failure); }
        });
        capture.start(); mutation.start(); capture.join(5000); mutation.join(5000);
        assertFalse(capture.isAlive()); assertFalse(mutation.isAlive()); assertNull(error.get()); assertEquals(0, sends.get());
    }
}
