package com.gleam.shiguang;

import static org.junit.Assert.*;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Offline protocol fixtures only; no credentials, audio hardware, sockets or provider access. */
public class GleamSpeechManualAckTest {
    private static final String ID = "session_synthetic_current";
    private JSONObject created() throws Exception {
        return new JSONObject().put("type", "session.created").put("session", new JSONObject().put("id", ID).put("turn_detection", new JSONObject().put("type", "server_vad")));
    }
    private JSONObject ack(boolean omit) throws Exception {
        JSONObject event = new JSONObject(GleamSpeechSession.SESSION_UPDATE).put("type", "session.updated");
        JSONObject session = event.getJSONObject("session"); session.put("id", ID);
        if (omit) session.remove("turn_detection"); return event;
    }
    private void receive(GleamSpeechSessionTest.Fixture f, JSONObject event) { GleamSpeechProtocol.receive(f.session, event.toString()); }
    private GleamSpeechSessionTest.Fixture fixture(boolean diagnostic) {
        GleamSpeechSessionTest.Fixture f = new GleamSpeechSessionTest.Fixture();
        if (diagnostic) f.session = GleamSpeechSession.connectionTest(f, f, f);
        f.session.begin(); return f;
    }
    private void reason(GleamSpeechSessionTest.Fixture f, String expected) {
        assertEquals("SPEECH_PROTOCOL", f.code);
        assertEquals(expected, f.session.protocolReasons().get(0).name());
        assertFalse(f.session.protocolReasons().toString().contains(ID));
    }
    @Test public void omissionChangesOnlyContextualAcknowledgementWhileStatelessDefaultStaysStrict() throws Exception {
        JSONObject omitted = ack(true);
        assertFalse(GleamSpeechProtocol.safeAck(omitted.getJSONObject("session")));
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.ACK_TURN_DETECTION_MISSING), GleamSpeechProtocol.ackReasons(omitted));
        GleamSpeechSessionTest.Fixture f = fixture(true); receive(f, created()); receive(f, omitted);
        assertEquals(1, f.connections); assertEquals(0, f.errors); assertEquals(0, f.starts); assertEquals(0, f.stops);
        assertEquals(1, f.closes); assertEquals(Collections.singletonList(GleamSpeechSession.SESSION_UPDATE), f.sent);
    }
    @Test public void recordingConsumesOnePendingAcknowledgementAndDuplicateCannotRestart() throws Exception {
        GleamSpeechSessionTest.Fixture f = fixture(false); receive(f, created());
        assertEquals(0, f.starts); receive(f, ack(true)); assertEquals(1, f.starts);
        receive(f, ack(true)); reason(f, "ACK_UNEXPECTED_SESSION_EVENT");
        assertEquals(1, f.starts); assertEquals(1, f.stops); assertEquals(0, f.results);
        assertFalse(f.sent.stream().anyMatch(value -> value.contains("input_audio_buffer") || value.contains("response.create")));
    }
    @Test public void earlyOutOfOrderAndDuplicateCreatedNeverAuthorizeAnAcknowledgement() throws Exception {
        for (boolean omit : new boolean[]{false, true}) {
            GleamSpeechSessionTest.Fixture early = fixture(false); receive(early, ack(omit));
            reason(early, "ACK_UNEXPECTED_SESSION_EVENT"); receive(early, created()); receive(early, ack(omit)); assertEquals(0, early.starts);
            GleamSpeechSessionTest.Fixture duplicate = fixture(false); receive(duplicate, created()); receive(duplicate, created()); receive(duplicate, ack(omit));
            reason(duplicate, "ACK_UNEXPECTED_SESSION_EVENT"); assertEquals(0, duplicate.starts); assertEquals(1, duplicate.sent.size());
        }
    }
    @Test public void failedSendDoesNotLeaveAnyAcknowledgementAuthority() throws Exception {
        GleamSpeechSessionTest.Fixture f = fixture(false); f.sendOk = false; receive(f, created());
        assertEquals("SPEECH_NETWORK", f.code); f.sendOk = true; receive(f, ack(true)); receive(f, created()); receive(f, ack(false));
        assertEquals(0, f.starts); assertEquals(1, f.sent.size()); assertEquals(1, f.errors);
    }
    @Test public void thrownTransportSendCannotLeavePendingAuthorityOrLeakItsMessage() throws Exception {
        GleamSpeechSessionTest.Fixture f = new GleamSpeechSessionTest.Fixture() {
            @Override public boolean send(String message) { sent.add(message); throw new IllegalStateException("synthetic-private-transport-detail"); }
        };
        f.session.begin(); receive(f, created()); receive(f, ack(true));
        assertEquals("SPEECH_NETWORK", f.code); assertTrue(f.session.protocolReasons().isEmpty());
        assertEquals(0, f.starts); assertEquals(1, f.closes); assertEquals(1, f.errors);
    }
    @Test public void reentrantAcknowledgementBeforeSuccessfulSendReturnFailsClosed() throws Exception {
        final String early = ack(false).toString();
        GleamSpeechSessionTest.Fixture f = new GleamSpeechSessionTest.Fixture() {
            @Override public boolean send(String message) { sent.add(message); GleamSpeechProtocol.receive(session, early); return true; }
        };
        f.session.begin(); receive(f, created()); receive(f, ack(true));
        reason(f, "ACK_UNEXPECTED_SESSION_EVENT"); assertEquals(0, f.starts); assertEquals(1, f.closes);
    }
    @Test public void reentrantCancellationCannotRestorePendingAuthorityAfterSendReturns() throws Exception {
        GleamSpeechSessionTest.Fixture f = new GleamSpeechSessionTest.Fixture() {
            @Override public boolean send(String message) { sent.add(message); session.cancel("SPEECH_CANCELLED"); return true; }
        };
        f.session.begin(); receive(f, created()); receive(f, ack(true));
        assertEquals("SPEECH_CANCELLED", f.code); assertEquals(0, f.starts); assertEquals(1, f.closes);
    }
    @Test public void comparesServerSessionIdsOnlyWhenPresentAndNeverRequiresEventIdEcho() throws Exception {
        for (boolean createdId : new boolean[]{false, true}) for (boolean updatedId : new boolean[]{false, true}) {
            JSONObject c = created(), a = ack(true);
            if (!createdId) c.getJSONObject("session").remove("id");
            if (!updatedId) a.getJSONObject("session").remove("id");
            c.put("event_id", "synthetic_created_event"); a.put("event_id", "different_synthetic_ack_event");
            GleamSpeechSessionTest.Fixture f = fixture(true); receive(f, c); receive(f, a); assertEquals(1, f.connections);
        }
        GleamSpeechSessionTest.Fixture mismatch = fixture(false); receive(mismatch, created());
        JSONObject a = ack(true); a.getJSONObject("session").put("id", "synthetic_old_session"); receive(mismatch, a);
        reason(mismatch, "ACK_SERVER_SESSION_ID_MISMATCH"); assertEquals(0, mismatch.starts);
    }
    @Test public void presentInvalidOrWrongTypeServerIdsFailWithoutEchoing() throws Exception {
        for (boolean onCreated : new boolean[]{true, false}) {
            for (Object value : new Object[]{JSONObject.NULL, 12, false, new JSONObject(), new JSONArray()}) {
                GleamSpeechSessionTest.Fixture f = fixture(false); JSONObject c = created(), a = ack(true);
                (onCreated ? c : a).getJSONObject("session").put("id", value);
                receive(f, c); receive(f, a); reason(f, "ACK_SERVER_SESSION_ID_TYPE"); assertEquals(0, f.starts);
            }
            for (String value : new String[]{"", new String(new char[1025]).replace('\0', 'x')}) {
                GleamSpeechSessionTest.Fixture f = fixture(false); JSONObject c = created(), a = ack(true);
                (onCreated ? c : a).getJSONObject("session").put("id", value);
                receive(f, c); receive(f, a); reason(f, "ACK_SERVER_SESSION_ID_INVALID"); assertEquals(0, f.starts);
            }
        }
    }
    @Test public void explicitVadWrongTypesAndNestedContradictionsAreNeverCompatible() throws Exception {
        for (Object value : new Object[]{new JSONObject().put("type", "server_vad"), false, "null", new JSONArray()}) {
            GleamSpeechSessionTest.Fixture top = fixture(false); receive(top, created()); JSONObject a = ack(false);
            a.getJSONObject("session").put("turn_detection", value); receive(top, a); assertEquals("SPEECH_PROTOCOL", top.code); assertEquals(0, top.starts);
            for (boolean omit : new boolean[]{false, true}) for (boolean inInput : new boolean[]{false, true}) {
                GleamSpeechSessionTest.Fixture nested = fixture(false); receive(nested, created()); a = ack(omit);
                JSONObject location = a.getJSONObject("session").getJSONObject("audio"); if (inInput) location = location.getJSONObject("input");
                location.put("turn_detection", value); receive(nested, a); reason(nested, "ACK_NESTED_TURN_DETECTION"); assertEquals(0, nested.starts);
            }
        }
        GleamSpeechSessionTest.Fixture noAuthority = fixture(false); JSONObject nestedNull = ack(true);
        nestedNull.getJSONObject("session").getJSONObject("audio").getJSONObject("input").put("turn_detection", JSONObject.NULL);
        receive(noAuthority, nestedNull); reason(noAuthority, "ACK_UNEXPECTED_SESSION_EVENT"); assertEquals(0, noAuthority.starts);
        GleamSpeechSessionTest.Fixture pending = fixture(true); receive(pending, created()); receive(pending, nestedNull); assertEquals(1, pending.connections);
    }
    @Test public void omittedTurnDetectionCannotHideAnyOtherExistingFailedCheck() throws Exception {
        String[] paths = {"model", "modalities", "input_audio_transcription", "input_audio_transcription.model", "audio", "audio.input", "audio.input.format", "audio.input.format.type", "audio.input.format.sample_rate", "audio.input.format.channels", "audio.input.format.sample_format", "audio.input.format.packing", "audio.input.format.channel_layout", "enable_search", "tools"};
        Object[] values = {JSONObject.NULL, true, false, 0, 1, 2, 16000, 16000.5, "", "1", "16000", "true", "false", "pcm", "text", "s16le", "interleaved", "mono", "synthetic_mismatch", new JSONObject(), new JSONArray(), new JSONArray("[\"text\"]"), new JSONArray("[\"audio\"]")};
        for (String path : paths) for (Object value : values) {
            JSONObject a = ack(true); JSONObject parent = a.getJSONObject("session"); String[] parts = path.split("\\.");
            for (int i = 0; i < parts.length - 1; i++) parent = parent.getJSONObject(parts[i]); parent.put(parts[parts.length - 1], value);
            JSONObject explicit = new JSONObject(a.toString()); explicit.getJSONObject("session").put("turn_detection", JSONObject.NULL);
            boolean expected = GleamSpeechProtocol.safeAck(explicit.getJSONObject("session"));
            GleamSpeechSessionTest.Fixture f = fixture(true); receive(f, created()); receive(f, a);
            assertEquals(path, expected ? 1 : 0, f.connections); assertEquals(path, expected ? 0 : 1, f.errors); assertEquals(0, f.starts);
        }
    }
    @Test public void teardownTimeoutAndOldSessionAcknowledgementsCannotAuthorizeSuccessor() throws Exception {
        for (String code : new String[]{"SPEECH_CANCELLED", "SPEECH_INTERRUPTED", "SPEECH_KEY_CHANGED", "SPEECH_TIMEOUT"}) {
            GleamSpeechSessionTest.Fixture old = fixture(false); receive(old, created()); old.session.cancel(code); receive(old, ack(true)); assertEquals(0, old.starts);
            GleamSpeechSessionTest.Fixture successor = fixture(false); receive(successor, ack(true)); receive(successor, created()); receive(successor, ack(true));
            reason(successor, "ACK_UNEXPECTED_SESSION_EVENT"); assertEquals(0, successor.starts);
        }
        GleamSpeechSessionTest.Fixture timeout = fixture(false); receive(timeout, created()); timeout.scheduled.get(0).run(); receive(timeout, ack(true));
        assertEquals("SPEECH_TIMEOUT", timeout.code); assertEquals(0, timeout.starts);
    }
    @Test public void unsolicitedVadAndResponseCreationFailClosedInEveryLivePhase() throws Exception {
        for (String event : new String[]{"input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped", "response.created"}) for (int phase = 0; phase < 4; phase++) {
            GleamSpeechSessionTest.Fixture f = fixture(false);
            if (phase >= 1) receive(f, created()); if (phase >= 2) receive(f, ack(true)); if (phase >= 3) { f.pcm(); f.session.stop(); }
            receive(f, new JSONObject().put("type", event));
            reason(f, "response.created".equals(event) ? "UNEXPECTED_RESPONSE_EVENT" : "UNEXPECTED_VAD_EVENT");
            assertEquals(phase >= 2 ? 1 : 0, f.starts); assertEquals(phase >= 2 ? 1 : 0, f.stops); assertEquals(0, f.results);
            receive(f, ack(true)); assertEquals(phase >= 2 ? 1 : 0, f.starts);
        }
    }
}
