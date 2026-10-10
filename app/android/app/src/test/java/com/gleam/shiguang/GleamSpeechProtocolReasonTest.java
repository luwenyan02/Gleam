package com.gleam.shiguang;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** No provider access. Only synthetic field shapes and fixed diagnostic codes. */
public class GleamSpeechProtocolReasonTest {
    private static final Object MISSING = new Object();
    private static final String PRIVATE_MARKER = "synthetic-private-value-never-return";
    private JSONObject acknowledgement() throws Exception {
        JSONObject event = new JSONObject(GleamSpeechSession.SESSION_UPDATE);
        event.put("type", "session.updated");
        event.getJSONObject("session").put("model", GleamSpeechTransport.MODEL);
        return event;
    }
    private JSONObject changed(String path, Object value) throws Exception {
        JSONObject event = acknowledgement();
        String[] parts = path.split("\\."); JSONObject parent = event;
        for (int i = 0; i < parts.length - 1; i++) parent = parent.getJSONObject(parts[i]);
        if (value == MISSING) parent.remove(parts[parts.length - 1]); else parent.put(parts[parts.length - 1], value);
        return event;
    }
    private GleamSpeechSessionTest.Fixture diagnostic() {
        GleamSpeechSessionTest.Fixture f = new GleamSpeechSessionTest.Fixture();
        f.session = GleamSpeechSession.connectionTest(f, f, f); f.session.begin();
        f.session.event("session.created", null, null, -1, true); return f;
    }
    private List<GleamSpeechProtocolReason> reject(JSONObject event) {
        GleamSpeechSessionTest.Fixture f = diagnostic(); GleamSpeechProtocol.receive(f.session, event.toString());
        assertEquals("SPEECH_PROTOCOL", f.code); assertEquals("configuring", f.session.phase().value);
        assertEquals(0, f.starts); assertEquals(0, f.connections); assertEquals(1, f.closes); assertEquals(1, f.sent.size());
        assertFalse(f.session.protocolReasons().toString().contains(PRIVATE_MARKER));
        assertFalse(f.session.protocolReasons().isEmpty()); return f.session.protocolReasons();
    }
    private Object[][] ackCases() throws Exception {
        return new Object[][] {
            {"session", MISSING, "ACK_SESSION_MISSING"},
            {"session", JSONObject.NULL, "ACK_SESSION_NULL"},
            {"session", PRIVATE_MARKER, "ACK_SESSION_TYPE"},
            {"session.model", 7, "ACK_MODEL_TYPE"},
            {"session.model", PRIVATE_MARKER, "ACK_MODEL_MISMATCH"},
            {"session.turn_detection", MISSING, "ACK_TURN_DETECTION_MISSING"},
            {"session.turn_detection", PRIVATE_MARKER, "ACK_TURN_DETECTION_TYPE"},
            {"session.turn_detection", new JSONObject().put("type", "server_vad"), "ACK_TURN_DETECTION_MISMATCH"},
            {"session.modalities", MISSING, "ACK_MODALITIES_MISSING"},
            {"session.modalities", PRIVATE_MARKER, "ACK_MODALITIES_TYPE"},
            {"session.modalities", new JSONArray("[\"text\",\"audio\"]"), "ACK_MODALITIES_MISMATCH"},
            {"session.input_audio_transcription", MISSING, "ACK_TRANSCRIPTION_MISSING"},
            {"session.input_audio_transcription", PRIVATE_MARKER, "ACK_TRANSCRIPTION_TYPE"},
            {"session.input_audio_transcription.model", MISSING, "ACK_TRANSCRIPTION_MODEL_MISSING"},
            {"session.input_audio_transcription.model", 7, "ACK_TRANSCRIPTION_MODEL_TYPE"},
            {"session.input_audio_transcription.model", PRIVATE_MARKER, "ACK_TRANSCRIPTION_MODEL_MISMATCH"},
            {"session.audio", MISSING, "ACK_AUDIO_MISSING"},
            {"session.audio", PRIVATE_MARKER, "ACK_AUDIO_TYPE"},
            {"session.audio.input", MISSING, "ACK_AUDIO_INPUT_MISSING"},
            {"session.audio.input", PRIVATE_MARKER, "ACK_AUDIO_INPUT_TYPE"},
            {"session.audio.input.format", MISSING, "ACK_AUDIO_FORMAT_MISSING"},
            {"session.audio.input.format", PRIVATE_MARKER, "ACK_AUDIO_FORMAT_TYPE"},
            {"session.audio.input.format.type", MISSING, "ACK_AUDIO_ENCODING_MISSING"},
            {"session.audio.input.format.type", 7, "ACK_AUDIO_ENCODING_TYPE"},
            {"session.audio.input.format.type", PRIVATE_MARKER, "ACK_AUDIO_ENCODING_MISMATCH"},
            {"session.audio.input.format.sample_rate", MISSING, "ACK_SAMPLE_RATE_MISSING"},
            {"session.audio.input.format.sample_rate", PRIVATE_MARKER, "ACK_SAMPLE_RATE_TYPE"},
            {"session.audio.input.format.sample_rate", 24000, "ACK_SAMPLE_RATE_MISMATCH"},
            {"session.enable_search", "true", "ACK_SEARCH_TYPE"},
            {"session.enable_search", true, "ACK_SEARCH_ENABLED"},
            {"session.tools", PRIVATE_MARKER, "ACK_TOOLS_TYPE"},
            {"session.tools", new JSONArray().put(new JSONObject().put("name", PRIVATE_MARKER)), "ACK_TOOLS_NONEMPTY"},
            {"session.audio.input.format.channels", PRIVATE_MARKER, "ACK_CHANNELS_TYPE"},
            {"session.audio.input.format.channels", 2, "ACK_CHANNELS_MISMATCH"},
            {"session.audio.input.format.sample_format", 7, "ACK_SAMPLE_FORMAT_TYPE"},
            {"session.audio.input.format.sample_format", PRIVATE_MARKER, "ACK_SAMPLE_FORMAT_MISMATCH"},
            {"session.audio.input.format.packing", 7, "ACK_PACKING_TYPE"},
            {"session.audio.input.format.packing", PRIVATE_MARKER, "ACK_PACKING_MISMATCH"},
            {"session.audio.input.format.channel_layout", 7, "ACK_CHANNEL_LAYOUT_TYPE"},
            {"session.audio.input.format.channel_layout", PRIVATE_MARKER, "ACK_CHANNEL_LAYOUT_MISMATCH"}
        };
    }
    @Test public void everyAcknowledgementReasonHasAnExactSyntheticFailureCase() throws Exception {
        for (Object[] c : ackCases()) {
            List<GleamSpeechProtocolReason> reasons = reject(changed((String) c[0], c[1]));
            assertEquals(c[0].toString(), Collections.singletonList(GleamSpeechProtocolReason.valueOf((String) c[2])), reasons);
        }
    }
    @Test public void nullAndWrongTypesAreClassifiedWithoutInspectingOrReturningValues() throws Exception {
        for (Object[] c : ackCases()) {
            if (!c[2].toString().endsWith("_TYPE") || c[2].equals("ACK_SESSION_TYPE") || c[2].equals("ACK_SEARCH_TYPE")) continue;
            for (Object value : new Object[]{JSONObject.NULL, Boolean.TRUE}) {
                // turn_detection accepts an object-shaped provider setting but requires null.
                if (c[2].equals("ACK_TURN_DETECTION_TYPE")) continue;
                List<GleamSpeechProtocolReason> reasons = reject(changed((String) c[0], value));
                assertEquals(Collections.singletonList(GleamSpeechProtocolReason.valueOf((String) c[2])), reasons);
            }
        }
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.ACK_MODALITIES_TYPE), reject(changed("session.modalities", new JSONArray().put(7))));
    }
    @Test public void collectsIndependentFailuresInStableOrderAndSkipsMissingParentDescendants() throws Exception {
        JSONObject event = changed("session.model", PRIVATE_MARKER);
        JSONObject session = event.getJSONObject("session");
        session.put("modalities", new JSONArray("[\"audio\"]")); session.remove("input_audio_transcription"); session.remove("audio");
        session.put("enable_search", true); session.put("tools", new JSONArray().put(PRIVATE_MARKER));
        assertEquals(Arrays.asList(GleamSpeechProtocolReason.ACK_MODEL_MISMATCH, GleamSpeechProtocolReason.ACK_MODALITIES_MISMATCH,
            GleamSpeechProtocolReason.ACK_TRANSCRIPTION_MISSING, GleamSpeechProtocolReason.ACK_AUDIO_MISSING,
            GleamSpeechProtocolReason.ACK_SEARCH_ENABLED, GleamSpeechProtocolReason.ACK_TOOLS_NONEMPTY), reject(event));
    }
    @Test public void optionalAbsenceAndExistingCoercionAcceptanceAreUnchanged() throws Exception {
        JSONObject event = acknowledgement(); JSONObject session = event.getJSONObject("session");
        for (String key : new String[]{"model", "enable_search", "tools"}) session.remove(key);
        JSONObject format = session.getJSONObject("audio").getJSONObject("input").getJSONObject("format");
        for (String key : new String[]{"channels", "sample_format", "packing", "channel_layout"}) format.remove(key);
        assertTrue(GleamSpeechProtocol.safeAck(session)); assertTrue(GleamSpeechProtocol.ackReasons(event).isEmpty());
        // Existing coercions are characterized, not broadened by the diagnostic.
        format.put("sample_rate", "16000"); format.put("channels", "1"); session.put("enable_search", "false");
        assertTrue(GleamSpeechProtocol.safeAck(session)); assertTrue(GleamSpeechProtocol.ackReasons(event).isEmpty());
        session.put("model", PRIVATE_MARKER);
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.ACK_MODEL_MISMATCH), GleamSpeechProtocol.ackReasons(event));
    }
    @Test public void injectedReasonsAndProviderBodiesNeverBecomeDiagnostics() throws Exception {
        JSONObject event = changed("session.audio.input.format", MISSING);
        event.put("reason", PRIVATE_MARKER); event.put("reasons", new JSONArray().put(PRIVATE_MARKER)); event.put("message", PRIVATE_MARKER);
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.ACK_AUDIO_FORMAT_MISSING), reject(event));
        GleamSpeechSessionTest.Fixture f = diagnostic();
        GleamSpeechProtocol.receive(f.session, new JSONObject().put("type", "error").put("reason", PRIVATE_MARKER).put("error", new JSONObject().put("code", PRIVATE_MARKER).put("message", PRIVATE_MARKER)).toString());
        assertEquals("SPEECH_PROVIDER", f.code); assertTrue(f.session.protocolReasons().isEmpty());
    }
    @Test public void framesAndProcessingErrorsUseSeparateFixedReasons() {
        for (String frame : new String[]{null, "not json " + PRIVATE_MARKER, "[", "[]"}) {
            GleamSpeechSessionTest.Fixture f = diagnostic(); GleamSpeechProtocol.receive(f.session, frame);
            assertEquals(Collections.singletonList(GleamSpeechProtocolReason.FRAME_MALFORMED_JSON), f.session.protocolReasons());
        }
        GleamSpeechSessionTest.Fixture oversized = diagnostic();
        GleamSpeechProtocol.receive(oversized.session, new String(new char[GleamSpeechSession.MAX_EVENT_CHARS + 1]).replace('\0', 'x'));
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.FRAME_OVERSIZED), oversized.session.protocolReasons());
        GleamSpeechSessionTest.Fixture binary = diagnostic(); GleamSpeechProtocol.receiveBinary(binary.session);
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.FRAME_BINARY), binary.session.protocolReasons());
        GleamSpeechSessionTest.Fixture processing = diagnostic();
        GleamSpeechProtocol.dispatch(processing.session, new JSONObject() { @Override public String optString(String key) { throw new IllegalStateException(PRIVATE_MARKER); } });
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.FRAME_PROCESSING_FAILED), processing.session.protocolReasons());
    }
    @Test public void engineProtocolFailuresHaveFixedReasonsAndNoItemIds() {
        GleamSpeechSessionTest.Fixture unsafe = diagnostic(); unsafe.session.event("session.updated", null, null, -1, false);
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.ACK_UNSAFE_CONFIGURATION), unsafe.session.protocolReasons());
        GleamSpeechSessionTest.Fixture unknown = diagnostic(); unknown.session.cancel("SPEECH_PROTOCOL");
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.PROTOCOL_UNCLASSIFIED), unknown.session.protocolReasons());
        GleamSpeechSessionTest.Fixture invalid = recording(); invalid.session.event("input_audio_buffer.committed", null, null, -1, true);
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.COMMIT_ITEM_ID_INVALID), invalid.session.protocolReasons());
        GleamSpeechSessionTest.Fixture commit = recording(); commit.committed(); commit.session.event("input_audio_buffer.committed", PRIVATE_MARKER, null, -1, true);
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.COMMIT_ITEM_ID_CONFLICT), commit.session.protocolReasons());
        GleamSpeechSessionTest.Fixture transcript = recording(); transcript.finalText("synthetic text");
        transcript.session.event("conversation.item.input_audio_transcription.completed", PRIVATE_MARKER, "synthetic other text", 0, true);
        assertEquals(Collections.singletonList(GleamSpeechProtocolReason.TRANSCRIPT_ITEM_ID_CONFLICT), transcript.session.protocolReasons());
    }
    private GleamSpeechSessionTest.Fixture recording() {
        GleamSpeechSessionTest.Fixture f = new GleamSpeechSessionTest.Fixture(); f.ready(); f.pcm(); f.session.stop(); return f;
    }
    @Test public void reasonStorageIsBoundedDistinctImmutableAndCannotSurviveAsAnotherError() {
        List<GleamSpeechProtocolReason> all = new ArrayList<>(Arrays.asList(GleamSpeechProtocolReason.values())); all.add(null); all.addAll(all.subList(0, 4));
        GleamSpeechSessionTest.Fixture f = diagnostic(); f.session.cancel("SPEECH_PROTOCOL", all);
        assertEquals(24, f.session.protocolReasons().size()); assertEquals(24, EnumSet.copyOf(f.session.protocolReasons()).size());
        all.clear(); assertEquals(24, f.session.protocolReasons().size());
        try { f.session.protocolReasons().clear(); fail("Diagnostic reasons must be immutable"); } catch (UnsupportedOperationException expected) {}
        GleamSpeechSessionTest.Fixture cancelled = diagnostic(); cancelled.session.cancel("SPEECH_CANCELLED", Arrays.asList(GleamSpeechProtocolReason.ACK_MODEL_MISMATCH));
        assertTrue(cancelled.session.protocolReasons().isEmpty());
        GleamSpeechProtocol.receiveBinary(cancelled.session); assertTrue(cancelled.session.protocolReasons().isEmpty());
    }
    @Test public void everyAllowlistedEnumIsCoveredAndNoExtraReasonCanBeEchoed() throws Exception {
        EnumSet<GleamSpeechProtocolReason> covered = EnumSet.noneOf(GleamSpeechProtocolReason.class);
        for (Object[] c : ackCases()) covered.add(GleamSpeechProtocolReason.valueOf((String)c[2]));
        for (String reason : new String[]{"ACK_UNSAFE_CONFIGURATION", "FRAME_MALFORMED_JSON", "FRAME_OVERSIZED", "FRAME_BINARY", "FRAME_PROCESSING_FAILED", "COMMIT_ITEM_ID_INVALID", "COMMIT_ITEM_ID_CONFLICT", "TRANSCRIPT_ITEM_ID_CONFLICT", "PROTOCOL_UNCLASSIFIED"}) covered.add(GleamSpeechProtocolReason.valueOf(reason));
        assertEquals(49, covered.size()); assertEquals(EnumSet.allOf(GleamSpeechProtocolReason.class), covered);
        try { GleamSpeechProtocolReason.valueOf(PRIVATE_MARKER); fail("Unknown string must not become a reason"); } catch (IllegalArgumentException expected) {}
    }
    @Test public void classifierAndHandshakeMatchLegacyAcceptanceAcrossFieldShapes() throws Exception {
        String[] paths = {"session", "session.model", "session.turn_detection", "session.modalities", "session.input_audio_transcription", "session.input_audio_transcription.model", "session.audio", "session.audio.input", "session.audio.input.format", "session.audio.input.format.type", "session.audio.input.format.sample_rate", "session.audio.input.format.channels", "session.audio.input.format.sample_format", "session.audio.input.format.packing", "session.audio.input.format.channel_layout", "session.enable_search", "session.tools"};
        Object[] values = {MISSING, JSONObject.NULL, true, false, 0, 1, 2, 16000, 16000.5, 24000, "", "1", "16000", "16000.0", "true", "false", "pcm", "text", "s16le", "interleaved", "mono", GleamSpeechTransport.MODEL, "qwen3-asr-flash-realtime", PRIVATE_MARKER, new JSONObject(), new JSONObject().put("private", PRIVATE_MARKER), new JSONArray(), new JSONArray("[\"text\"]"), new JSONArray("[\"audio\"]"), new JSONArray("[\"text\",\"audio\"]"), new JSONArray().put(7)};
        for (String path : paths) for (Object value : values) {
            JSONObject event = changed(path, value);
            boolean legacy = legacySafeAck(event.optJSONObject("session"));
            assertEquals(path, legacy, GleamSpeechProtocol.safeAck(event.optJSONObject("session")));
            assertEquals(path, legacy, GleamSpeechProtocol.ackReasons(event).isEmpty());
            GleamSpeechSessionTest.Fixture f = diagnostic(); GleamSpeechProtocol.receive(f.session, event.toString());
            assertEquals(path, legacy ? 1 : 0, f.connections); assertEquals(path, legacy ? 0 : 1, f.errors); assertEquals(0, f.starts);
        }
    }
    @Test public void maximumIndependentAcknowledgementFailuresFitWithoutTruncation() throws Exception {
        JSONObject event = acknowledgement(); JSONObject session = event.getJSONObject("session");
        session.put("model", PRIVATE_MARKER); session.put("turn_detection", new JSONObject()); session.put("modalities", new JSONArray());
        session.getJSONObject("input_audio_transcription").put("model", PRIVATE_MARKER);
        JSONObject format = session.getJSONObject("audio").getJSONObject("input").getJSONObject("format");
        format.put("type", PRIVATE_MARKER); format.put("sample_rate", 24000); format.put("channels", 2);
        format.put("sample_format", PRIVATE_MARKER); format.put("packing", PRIVATE_MARKER); format.put("channel_layout", PRIVATE_MARKER);
        session.put("enable_search", true); session.put("tools", new JSONArray().put(new JSONObject()));
        List<GleamSpeechProtocolReason> reasons = reject(event);
        assertEquals(12, reasons.size()); assertTrue(reasons.size() < GleamSpeechProtocolReason.MAX_REASONS);
    }
    // v1.10.1 acceptance predicate retained as an independent regression oracle.
    private static boolean legacySafeAck(JSONObject session) {
        if (session == null || (session.has("model") && !GleamSpeechTransport.MODEL.equals(session.optString("model"))) || !session.has("turn_detection") || !session.isNull("turn_detection")) return false;
        JSONArray modalities = session.optJSONArray("modalities");
        if (modalities == null || modalities.length() != 1 || !"text".equals(modalities.optString(0))) return false;
        JSONObject transcription = session.optJSONObject("input_audio_transcription");
        if (transcription == null || !"qwen3-asr-flash-realtime".equals(transcription.optString("model"))) return false;
        JSONObject audio = session.optJSONObject("audio"), input = audio == null ? null : audio.optJSONObject("input"), format = input == null ? null : input.optJSONObject("format");
        if (format == null || !"pcm".equals(format.optString("type")) || format.optInt("sample_rate", -1) != 16000) return false;
        return !session.optBoolean("enable_search", false)
            && (!session.has("tools") || (session.optJSONArray("tools") != null && session.optJSONArray("tools").length() == 0))
            && (!format.has("channels") || format.optInt("channels", -1) == 1)
            && (!format.has("sample_format") || "s16le".equals(format.optString("sample_format")))
            && (!format.has("packing") || "interleaved".equals(format.optString("packing")))
            && (!format.has("channel_layout") || "mono".equals(format.optString("channel_layout")));
    }

}
