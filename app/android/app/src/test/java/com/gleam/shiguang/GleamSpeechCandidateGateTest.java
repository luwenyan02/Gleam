package com.gleam.shiguang;

import static org.junit.Assert.*;
import org.junit.Test;

/** In-memory synthetic storage only: no service, audio, Android Keystore or real credentials. */
public class GleamSpeechCandidateGateTest {
    private static final GleamSpeechCandidateGate.Config CONFIG = new GleamSpeechCandidateGate.Config("beijing", "synthetic-workspace", GleamSpeechTransport.MODEL);
    static class Store implements GleamSpeechCandidateGate.Store {
        String revision = "voice-old", mainRevision = "main-old", value = "synthetic-old-working-key", main = "synthetic-main-key", source = "separate";
        GleamSpeechCandidateGate.Config config;
        int writes;
        boolean fail;
        public String revision() { return revision; }
        public String mainRevision() { return mainRevision; }
        public String independentKey() { return value; }
        public String mainKey() { return main; }
        public GleamSpeechCandidateGate.Receipt commit(String key, String keySource, String expectedMain, GleamSpeechCandidateGate.Config next) throws Exception {
            if (fail) throw new Exception("synthetic storage failure");
            value = key; source = keySource; config = next; revision = "voice-new-" + ++writes;
            return new GleamSpeechCandidateGate.Receipt(revision, mainRevision, source, GleamSpeechCandidateGate.mask(key), GleamSpeechCandidateGate.mask(main), true, config);
        }
    }
    static final class Fixture {
        final Store store = new Store();
        final GleamSpeechCandidateGate gate = new GleamSpeechCandidateGate(store, new Object());
        Fixture() { gate.invalidateConfiguration("config_current"); }
        void begin(String id, String source, String value) throws Exception { gate.begin(id, "voice-old", "main-old", "config_current", source, value, CONFIG); }
        String ack(String id) throws Exception { return gate.acknowledge(id, true, false); }
        void commit(String id, String token) throws Exception { gate.commit(id, token, "voice-old", "main-old", "config_current", true, false); }
    }
    private void rejects(String code, Throwing action) throws Exception {
        try { action.run(); fail("expected " + code); } catch (GleamSpeechCandidateGate.Failure failure) { assertEquals(code, failure.code); }
    }
    interface Throwing { void run() throws Exception; }
    @Test public void sharedServiceConfigIsPersistedOnlyAfterTestingAndKeepsItsIdentity() throws Exception {
        Fixture f = new Fixture();
        GleamSpeechCandidateGate.Config shared = new GleamSpeechCandidateGate.Config("beijing", "", GleamSpeechTransport.MODEL);
        f.gate.begin("session_one", "voice-old", "main-old", "config_current", "separate", "synthetic-candidate-key", shared);
        assertEquals(0, f.store.writes);
        String token = f.ack("session_one");
        f.commit("session_one", token);
        assertEquals(1, f.store.writes);
        assertEquals(shared, f.store.config);
        assertNotEquals(CONFIG, f.store.config);
        assertNotEquals(new GleamSpeechCandidateGate.Config("singapore", "", GleamSpeechTransport.MODEL), f.store.config);
        f.store.config.validate();
    }
    @Test public void testOnlyAndAckNeverPersistBeforeExplicitCommit() throws Exception {
        Fixture f = new Fixture(); f.begin("session_one", "separate", "synthetic-candidate-key");
        assertEquals("synthetic-candidate-key", f.gate.transportKey("session_one")); assertEquals(0, f.store.writes);
        String token = f.ack("session_one"); assertEquals(0, f.store.writes); assertEquals("synthetic-old-working-key", f.store.value);
        f.commit("session_one", token); assertEquals(1, f.store.writes); assertEquals("synthetic-candidate-key", f.store.value);
        assertEquals(CONFIG, f.store.config); rejects("SPEECH_SESSION_INVALID", () -> f.commit("session_one", token));
    }
    @Test public void cancelFailureAndConfigurationEditCannotOverwriteOldCredential() throws Exception {
        for (int action = 0; action < 3; action++) {
            Fixture f = new Fixture(); f.begin("session_one", "separate", "synthetic-candidate-key"); String token = f.ack("session_one");
            if (action == 0) f.gate.cancel("session_one");
            else if (action == 1) f.gate.invalidateConfiguration("config_next");
            else f.gate.cancelAll();
            rejects("SPEECH_SESSION_INVALID", () -> f.commit("session_one", token));
            assertEquals("synthetic-old-working-key", f.store.value); assertEquals(0, f.store.writes);
        }
    }
    @Test public void failedOrAbsentAcknowledgementCannotSave() throws Exception {
        Fixture f = new Fixture(); f.begin("session_one", "separate", "synthetic-candidate-key");
        rejects("SPEECH_SESSION_INVALID", () -> f.commit("session_one", "forged_token")); assertEquals(0, f.store.writes);
        f.gate.cancel("session_one"); rejects("SPEECH_SESSION_INVALID", () -> f.ack("session_one"));
    }
    @Test public void backgroundAndDestructionInvalidateEvenAfterAcknowledgement() throws Exception {
        for (boolean destroyed : new boolean[]{false, true}) {
            Fixture f = new Fixture(); f.begin("session_one", "separate", "synthetic-candidate-key"); String token = f.ack("session_one");
            rejects("SPEECH_INTERRUPTED", () -> f.gate.commit("session_one", token, "voice-old", "main-old", "config_current", false, destroyed));
            rejects("SPEECH_SESSION_INVALID", () -> f.commit("session_one", token)); assertEquals(0, f.store.writes);
        }
    }
    @Test public void keyRotationsInvalidateBothCandidateSourcesAtAckAndCommit() throws Exception {
        for (String source : new String[]{"separate", "shared"}) for (boolean main : new boolean[]{false, true}) for (boolean beforeAck : new boolean[]{false, true}) {
            Fixture f = new Fixture(); f.begin("session_one", source, "separate".equals(source) ? "synthetic-candidate-key" : null);
            String token = beforeAck ? null : f.ack("session_one");
            if (main) f.store.mainRevision = "main-new"; else f.store.revision = "voice-new";
            if (beforeAck) rejects("SPEECH_KEY_CHANGED", () -> f.ack("session_one"));
            else rejects("SPEECH_KEY_CHANGED", () -> f.commit("session_one", token));
            assertEquals(0, f.store.writes); assertEquals("synthetic-old-working-key", f.store.value);
        }
    }
    @Test public void sharedReadsCurrentNativeMainKeyAndBindsExactRevision() throws Exception {
        Fixture f = new Fixture();
        rejects("SPEECH_KEY_CHANGED", () -> f.gate.begin("session_one", "voice-old", "main-stale", "config_current", "shared", null, CONFIG));
        f.begin("session_two", "shared", null); assertEquals("synthetic-main-key", f.gate.transportKey("session_two"));
        f.commit("session_two", f.ack("session_two")); assertEquals("shared", f.store.source); assertEquals("synthetic-main-key", f.store.value);
    }
    @Test public void staleCancellationCannotCancelNewerCandidateAndTokensCannotCrossSessions() throws Exception {
        Fixture f = new Fixture(); f.begin("session_old", "separate", "synthetic-first-key"); String token = f.ack("session_old");
        f.gate.cancel("session_old"); f.begin("session_new", "separate", "synthetic-second-key"); f.gate.cancel("session_old");
        rejects("SPEECH_SESSION_INVALID", () -> f.commit("session_old", token));
        String next = f.ack("session_new"); assertNotEquals(token, next); f.commit("session_new", next);
        assertEquals("synthetic-second-key", f.store.value);
    }
    @Test public void storageFailurePreservesPreviousWorkingCredentialAndConsumesCandidate() throws Exception {
        Fixture f = new Fixture(); f.begin("session_one", "separate", "synthetic-candidate-key"); String token = f.ack("session_one"); f.store.fail = true;
        rejects("SPEECH_KEY_STORAGE", () -> f.commit("session_one", token)); assertEquals("synthetic-old-working-key", f.store.value);
        f.store.fail = false; rejects("SPEECH_SESSION_INVALID", () -> f.commit("session_one", token));
    }
    @Test public void configurationChangesAreLinearizedBeforeCommitAndCannotBeReactivatedByOldBegin() throws Exception {
        Fixture f = new Fixture(); f.begin("session_one", "separate", "synthetic-candidate-key"); String token = f.ack("session_one");
        f.gate.invalidateConfiguration("config_new");
        rejects("SPEECH_SESSION_INVALID", () -> f.commit("session_one", token));
        rejects("SPEECH_SESSION_INVALID", () -> f.begin("session_late", "separate", "synthetic-late-key"));
        assertEquals(0, f.store.writes);
    }
    @Test public void shortMasksNeverRevealWholeKeyOrLengthAndLongMasksAreBounded() {
        for (String key : new String[]{null, "", "12345678", "1234567890", "12345678901", "123456789012"}) assertEquals(key == null || key.isEmpty() ? "" : "••••••", GleamSpeechCandidateGate.mask(key));
        assertEquals("abcde••••••vwxyz", GleamSpeechCandidateGate.mask("abcde-synthetic-middle-vwxyz"));
        assertEquals(16, GleamSpeechCandidateGate.mask("x".repeat(512)).length());
    }
    @Test public void invalidSourceConfigKeyAndMissingMainCannotAcquireAuthority() throws Exception {
        Fixture f = new Fixture();
        rejects("SPEECH_CONFIG_INVALID", () -> f.begin("session_one", "automatic", "synthetic-key"));
        rejects("SPEECH_KEY_REQUIRED", () -> f.begin("session_one", "separate", "short"));
        rejects("SPEECH_KEY_REQUIRED", () -> f.begin("session_one", "separate", "abcde••••••vwxyz"));
        rejects("SPEECH_KEY_REQUIRED", () -> f.begin("session_one", "separate", "••••••"));
        rejects("SPEECH_CONFIG_INVALID", () -> f.begin("session_one", "shared", "synthetic-js-override"));
        f.store.main = null; rejects("SPEECH_KEY_REQUIRED", () -> f.begin("session_one", "shared", null));
        rejects("SPEECH_CONFIG_INVALID", () -> f.gate.begin("session_one", "voice-old", "main-old", "config_current", "separate", "synthetic-key",
            new GleamSpeechCandidateGate.Config("unapproved", "synthetic-workspace", GleamSpeechTransport.MODEL)));
        assertEquals(0, f.store.writes);
    }
    @Test public void duplicateRequestsAndDuplicateAcknowledgementsFailClosed() throws Exception {
        Fixture f = new Fixture(); f.begin("session_one", "separate", "synthetic-candidate-key");
        rejects("SPEECH_BUSY", () -> f.begin("session_two", "separate", "synthetic-second-key"));
        String token = f.ack("session_one"); rejects("SPEECH_SESSION_INVALID", () -> f.ack("session_one"));
        rejects("SPEECH_SESSION_INVALID", () -> f.commit("session_one", token)); assertEquals(0, f.store.writes);
    }
    @Test public void testsReusingExistingSeparateCredentialDoNotConvertToShared() throws Exception {
        Fixture f = new Fixture(); f.begin("session_one", "separate", null);
        assertEquals("synthetic-old-working-key", f.gate.transportKey("session_one"));
        f.commit("session_one", f.ack("session_one")); assertEquals("separate", f.store.source);
    }
    @Test public void strictProtocolSuccessAloneGrantsOneCommitAndNeverCapturesAudio() throws Exception {
        for (boolean safe : new boolean[]{true, false}) {
            Fixture f = new Fixture(); f.begin("session_one", "separate", "synthetic-candidate-key");
            final String[] token = {null};
            GleamSpeechSessionTest.Fixture transport = new GleamSpeechSessionTest.Fixture() {
                @Override public void connected() {
                    super.connected();
                    try { token[0] = f.ack("session_one"); } catch (Exception error) { throw new AssertionError(error); }
                }
                @Override public void fail(String code) { super.fail(code); f.gate.cancel("session_one"); }
            };
            transport.session = GleamSpeechSession.connectionTest(transport, transport, transport);
            transport.session.begin(); transport.created();
            if (safe) transport.ack(); else transport.unsafeAck();
            assertEquals(0, transport.starts); assertEquals(0, transport.stops); assertEquals(0, f.store.writes);
            assertFalse(transport.sent.stream().anyMatch(value -> value.contains("input_audio_buffer") || value.contains("response.create")));
            if (safe) { assertNotNull(token[0]); f.commit("session_one", token[0]); assertEquals(1, f.store.writes); }
            else { assertNull(token[0]); rejects("SPEECH_SESSION_INVALID", () -> f.commit("session_one", "synthetic-forged")); }
        }
    }
    @Test public void oldProtocolAckAfterCancellationCannotGrantCommit() throws Exception {
        Fixture f = new Fixture(); f.begin("session_one", "separate", "synthetic-candidate-key");
        final int[] successes = {0};
        GleamSpeechSessionTest.Fixture transport = new GleamSpeechSessionTest.Fixture() {
            @Override public void connected() { successes[0]++; }
            @Override public void fail(String code) { f.gate.cancel("session_one"); }
        };
        transport.session = GleamSpeechSession.connectionTest(transport, transport, transport);
        transport.session.begin(); transport.created(); transport.session.cancel("SPEECH_CANCELLED"); transport.ack();
        assertEquals(0, successes[0]); assertEquals(0, transport.starts); assertEquals(0, f.store.writes);
        rejects("SPEECH_SESSION_INVALID", () -> f.ack("session_one"));
    }
    @Test public void concurrentConfigurationInvalidationCannotInterleaveInsideCommitTransaction() throws Exception {
        Object lock = new Object();
        java.util.concurrent.CountDownLatch committing = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<Throwable> error = new java.util.concurrent.atomic.AtomicReference<>();
        Store store = new Store() {
            @Override public GleamSpeechCandidateGate.Receipt commit(String value, String source, String main, GleamSpeechCandidateGate.Config config) throws Exception {
                committing.countDown();
                if (!release.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("test did not release commit");
                return super.commit(value, source, main, config);
            }
        };
        GleamSpeechCandidateGate gate = new GleamSpeechCandidateGate(store, lock);
        gate.invalidateConfiguration("config_current"); gate.begin("session_one", "voice-old", "main-old", "config_current", "separate", "synthetic-candidate-key", CONFIG);
        String token = gate.acknowledge("session_one", true, false);
        Thread commit = new Thread(() -> {
            try { gate.commit("session_one", token, "voice-old", "main-old", "config_current", true, false); }
            catch (Throwable failure) { error.set(failure); }
        });
        java.util.concurrent.atomic.AtomicBoolean invalidated = new java.util.concurrent.atomic.AtomicBoolean();
        Thread edit = new Thread(() -> { gate.invalidateConfiguration("config_next"); invalidated.set(true); });
        commit.start(); assertTrue(committing.await(5, java.util.concurrent.TimeUnit.SECONDS)); edit.start();
        // Commit owns the same lock used for edits/main-key writes. Cancellation cannot half-apply a save.
        assertFalse(invalidated.get()); release.countDown(); commit.join(5000); edit.join(5000);
        assertFalse(commit.isAlive()); assertFalse(edit.isAlive()); assertNull(error.get()); assertTrue(invalidated.get());
        assertEquals(1, store.writes); assertEquals(CONFIG, store.config);
        rejects("SPEECH_SESSION_INVALID", () -> gate.commit("session_one", token, "voice-old", "main-old", "config_current", true, false));
    }
    @Test public void unicodeMaskUsesCodePointsWithNoOverlapOrUnboundedLength() {
        String emoji = "😀";
        assertEquals("••••••", GleamSpeechCandidateGate.mask(emoji.repeat(15)));
        String masked = GleamSpeechCandidateGate.mask(emoji.repeat(16));
        assertEquals(emoji.repeat(5) + "••••••" + emoji.repeat(5), masked);
        assertEquals(16, masked.codePointCount(0, masked.length()));
    }

    @Test public void committedReceiptNeedsNoPostPublicationCredentialOrKeystoreRead() throws Exception {
        Store store = new Store() {
            @Override public String revision() { if (writes > 0) throw new IllegalStateException("post-commit read unavailable"); return super.revision(); }
            @Override public String mainRevision() { if (writes > 0) throw new IllegalStateException("post-commit read unavailable"); return super.mainRevision(); }
            @Override public String mainKey() { if (writes > 0) throw new IllegalStateException("post-commit Keystore unavailable"); return super.mainKey(); }
            @Override public String independentKey() { if (writes > 0) throw new IllegalStateException("post-commit Keystore unavailable"); return super.independentKey(); }
        };
        GleamSpeechCandidateGate gate = new GleamSpeechCandidateGate(store, new Object());
        gate.invalidateConfiguration("config_current"); gate.begin("session_one", "voice-old", "main-old", "config_current", "shared", null, CONFIG);
        String token = gate.acknowledge("session_one", true, false);
        GleamSpeechCandidateGate.Receipt receipt = gate.commit("session_one", token, "voice-old", "main-old", "config_current", true, false);
        assertEquals("voice-new-1", receipt.credentialRevision); assertEquals("main-old", receipt.mainCredentialRevision);
        assertEquals("shared", receipt.keySource); assertEquals(CONFIG, receipt.activeConfig); assertTrue(receipt.hasMainKey);
        assertEquals(GleamSpeechCandidateGate.mask("synthetic-main-key"), receipt.maskedKey);
        assertEquals(receipt.maskedKey, receipt.maskedMainKey); assertEquals(1, store.writes);
    }

}
