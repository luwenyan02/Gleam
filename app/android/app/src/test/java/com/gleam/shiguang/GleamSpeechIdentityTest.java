package com.gleam.shiguang;
import static org.junit.Assert.*;
import org.junit.Test;
public class GleamSpeechIdentityTest {
    @Test public void cancelledPermissionRequestCannotRestartAfterLateGrant() {
        GleamSpeechIdentity gate = new GleamSpeechIdentity(); assertTrue(gate.reserve("voice_old", "revision1", "revision1")); gate.end("voice_old");
        assertFalse(gate.mayContinue("voice_old", "revision1", true, false)); assertFalse(gate.reserve("voice_old", "revision1", "revision1"));
        assertTrue(gate.reserve("voice_new", "revision1", "revision1")); assertFalse(gate.mayContinue("voice_old", "revision1", true, false)); assertTrue(gate.mayContinue("voice_new", "revision1", true, false));
    }
    @Test public void stopBeforeStartAndOldSessionCancellationDoNotAffectNewSession() {
        GleamSpeechIdentity gate = new GleamSpeechIdentity(); gate.end("voice_early"); assertFalse(gate.reserve("voice_early", "r", "r"));
        assertTrue(gate.reserve("voice_new", "r", "r")); gate.end("voice_old"); assertTrue(gate.mayContinue("voice_new", "r", true, false));
    }
    @Test public void foregroundDestructionAndCredentialRotationGateEveryContinuation() {
        GleamSpeechIdentity gate = new GleamSpeechIdentity(); assertFalse(gate.reserve("voice_a", "old", "new")); assertTrue(gate.reserve("voice_a", "new", "new"));
        assertFalse(gate.mayContinue("voice_a", "new", false, false)); assertFalse(gate.mayContinue("voice_a", "new", true, true)); assertFalse(gate.mayContinue("voice_a", "changed", true, false));
    }
    @Test public void isolationTokenCannotClaimOtherSession() {
        GleamSpeechIdentity gate = new GleamSpeechIdentity(); assertTrue(gate.reserve("voice_a", "r", "r")); assertFalse(gate.reserve("voice_b", "r", "r")); assertFalse(gate.mayContinue("voice_b", "r", true, false));
    }
    @Test public void diagnosticAndRecordingShareOneReservationAndStaleCancelCannotEndSuccessor() {
        for (String first : new String[]{"diagnostic_first", "recording_first"}) {
            GleamSpeechIdentity gate = new GleamSpeechIdentity();
            assertTrue(gate.reserve(first, "revision", "revision"));
            assertFalse(gate.reserve("another_session", "revision", "revision"));
            gate.end(first); assertTrue(gate.reserve("another_session", "revision", "revision"));
            gate.end(first);
            assertTrue(gate.mayContinue("another_session", "revision", true, false));
            assertFalse(gate.mayContinue(first, "revision", true, false));
            assertFalse(gate.reserve(first, "revision", "revision"));
        }
    }

}
