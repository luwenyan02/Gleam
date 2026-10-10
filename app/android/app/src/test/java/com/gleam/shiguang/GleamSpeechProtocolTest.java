package com.gleam.shiguang;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Fictional IDs and content; official event shapes, with no credentials or provider access. */
public class GleamSpeechProtocolTest {
    private static final String CREATED = "{\"event_id\":\"event_synthetic_created\",\"type\":\"session.created\",\"session\":{\"id\":\"sess_synthetic\",\"object\":\"realtime.session\",\"model\":\"qwen3.8-omni-flash-realtime\",\"modalities\":[\"text\",\"audio\"],\"turn_detection\":{\"type\":\"server_vad\"}}}";
    private static final String UPDATED = "{\"event_id\":\"event_synthetic_updated\",\"type\":\"session.updated\",\"session\":{\"id\":\"sess_synthetic\",\"object\":\"realtime.session\",\"model\":\"qwen3.8-omni-flash-realtime\",\"modalities\":[\"text\"],\"turn_detection\":null,\"input_audio_transcription\":{\"model\":\"qwen3-asr-flash-realtime\"},\"enable_search\":false,\"tools\":[],\"audio\":{\"input\":{\"format\":{\"type\":\"pcm\",\"sample_rate\":16000,\"sample_format\":\"s16le\",\"channels\":1,\"packing\":\"interleaved\",\"channel_layout\":\"mono\"}}}}}";
    private GleamSpeechSessionTest.Fixture diagnostic() {
        GleamSpeechSessionTest.Fixture f = new GleamSpeechSessionTest.Fixture();
        f.session = GleamSpeechSession.connectionTest(f, f, f);
        f.session.begin();
        return f;
    }
    private JSONObject acknowledgement() throws Exception { return new JSONObject(UPDATED); }
    private void rejectAck(JSONObject event) {
        GleamSpeechSessionTest.Fixture f = diagnostic();
        GleamSpeechProtocol.receive(f.session, CREATED); GleamSpeechProtocol.receive(f.session, event.toString());
        assertEquals("SPEECH_PROTOCOL", f.code); assertEquals("configuring", f.session.phase().value);
        assertEquals(0, f.connections); assertEquals(0, f.starts); assertEquals(0, f.stops); assertEquals(1, f.closes);
        assertEquals(1, f.sent.size()); assertEquals(GleamSpeechSession.SESSION_UPDATE, f.sent.get(0));
    }
    @Test public void officialShapedCreatedThenSafeUpdateClosesWithoutAnyAudioOrAssistantRequest() throws Exception {
        GleamSpeechSessionTest.Fixture f = diagnostic();
        GleamSpeechProtocol.receive(f.session, CREATED);
        assertEquals(0, f.connections); assertEquals(0, f.starts); assertEquals(1, f.sent.size());
        JSONObject request = new JSONObject(f.sent.get(0));
        assertEquals("session.update", request.getString("type"));
        assertTrue(GleamSpeechProtocol.safeAck(request.getJSONObject("session")));
        GleamSpeechProtocol.receive(f.session, UPDATED);
        assertEquals(1, f.connections); assertEquals(0, f.results); assertEquals(0, f.starts); assertEquals(1, f.closes);
        assertEquals(1, f.sent.size()); assertFalse(f.sent.get(0).contains("input_audio_buffer")); assertFalse(f.sent.get(0).contains("response.create"));
        GleamSpeechProtocol.receive(f.session, UPDATED); GleamSpeechProtocol.receive(f.session, "invalid late event");
        assertEquals(1, f.connections); assertEquals(0, f.errors);
    }
    @Test public void missingOrWrongSessionModelTurnDetectionAndModalitiesFailClosed() throws Exception {
        JSONObject event = acknowledgement(); event.remove("session"); rejectAck(event);
        event = acknowledgement(); event.getJSONObject("session").put("model", "unverified-model"); rejectAck(event);
        event = acknowledgement(); event.getJSONObject("session").remove("turn_detection"); assertFalse(GleamSpeechProtocol.safeAck(event.getJSONObject("session")));
        event = acknowledgement(); event.getJSONObject("session").put("turn_detection", new JSONObject().put("type", "server_vad")); rejectAck(event);
        event = acknowledgement(); event.getJSONObject("session").remove("modalities"); rejectAck(event);
        for (JSONArray modalities : new JSONArray[]{new JSONArray(), new JSONArray("[\"audio\"]"), new JSONArray("[\"text\",\"audio\"]")}) {
            event = acknowledgement(); event.getJSONObject("session").put("modalities", modalities); rejectAck(event);
        }
    }
    @Test public void missingOrWrongInputTranscriptionAndPcmFieldsFailClosed() throws Exception {
        JSONObject event = acknowledgement(); event.getJSONObject("session").remove("input_audio_transcription"); rejectAck(event);
        event = acknowledgement(); event.getJSONObject("session").getJSONObject("input_audio_transcription").put("model", "unverified-asr"); rejectAck(event);
        for (String missing : new String[]{"audio", "input", "format"}) {
            event = acknowledgement(); JSONObject node = event.getJSONObject("session");
            if (!"audio".equals(missing)) node = node.getJSONObject("audio");
            if ("format".equals(missing)) node = node.getJSONObject("input");
            node.remove(missing); rejectAck(event);
        }
        for (String key : new String[]{"type", "sample_rate"}) {
            event = acknowledgement(); event.getJSONObject("session").getJSONObject("audio").getJSONObject("input").getJSONObject("format").remove(key); rejectAck(event);
        }
        Object[][] invalid = {{"type", "g711_ulaw"}, {"sample_rate", 24000}, {"sample_format", "f32le"}, {"channels", 2}, {"packing", "planar"}, {"channel_layout", "stereo"}};
        for (Object[] field : invalid) {
            event = acknowledgement(); event.getJSONObject("session").getJSONObject("audio").getJSONObject("input").getJSONObject("format").put((String) field[0], field[1]); rejectAck(event);
        }
    }
    @Test public void searchAndToolsCannotBeEnabled() throws Exception {
        JSONObject event = acknowledgement(); event.getJSONObject("session").put("enable_search", true); rejectAck(event);
        event = acknowledgement(); event.getJSONObject("session").put("tools", new JSONArray("[{\"type\":\"function\",\"name\":\"synthetic_tool\"}]")); rejectAck(event);
        event = acknowledgement(); event.getJSONObject("session").put("tools", "unexpected-type"); rejectAck(event);
    }
    @Test public void recordingAndDiagnosticUseIdenticalAcknowledgementValidation() throws Exception {
        GleamSpeechSessionTest.Fixture f = new GleamSpeechSessionTest.Fixture(); f.session.begin();
        GleamSpeechProtocol.receive(f.session, CREATED); assertEquals(0, f.starts);
        GleamSpeechProtocol.receive(f.session, UPDATED); assertEquals(1, f.starts); assertEquals(0, f.connections);
        GleamSpeechSessionTest.Fixture invalid = new GleamSpeechSessionTest.Fixture(); invalid.session.begin();
        GleamSpeechProtocol.receive(invalid.session, CREATED);
        JSONObject bad = acknowledgement(); bad.getJSONObject("session").put("modalities", new JSONArray("[\"audio\"]"));
        GleamSpeechProtocol.receive(invalid.session, bad.toString()); assertEquals(0, invalid.starts); assertEquals("SPEECH_PROTOCOL", invalid.code);
    }
    @Test public void reorderedAckAndAssistantOrTranscriptEventsDoNotCompleteDiagnostic() {
        GleamSpeechSessionTest.Fixture f = diagnostic();
        GleamSpeechProtocol.receive(f.session, UPDATED);
        GleamSpeechProtocol.receive(f.session, "{\"type\":\"response.text.done\",\"text\":\"synthetic assistant output\"}");
        GleamSpeechProtocol.receive(f.session, "{\"type\":\"conversation.item.input_audio_transcription.completed\",\"item_id\":\"item_synthetic\",\"content_index\":0,\"transcript\":\"虚构转录\"}");
        assertEquals(0, f.connections); assertEquals(0, f.results); assertEquals(0, f.starts); assertTrue(f.sent.isEmpty());
        GleamSpeechProtocol.receive(f.session, CREATED); GleamSpeechProtocol.receive(f.session, UPDATED); assertEquals(0, f.connections); assertEquals("SPEECH_PROTOCOL", f.code);
    }
    @Test public void malformedAndOversizedFramesUseSafeProtocolCodeWithoutEchoing() {
        for (String message : new String[]{null, "not JSON", "[]", "{", new String(new char[GleamSpeechSession.MAX_EVENT_CHARS + 1]).replace('\0', 'x')}) {
            GleamSpeechSessionTest.Fixture f = diagnostic(); GleamSpeechProtocol.receive(f.session, message);
            assertEquals("SPEECH_PROTOCOL", f.code); assertEquals("connecting", f.session.phase().value); assertEquals(0, f.starts); assertEquals(0, f.connections);
        }
    }
    @Test public void providerErrorsReturnOnlyExistingAllowlistedCategoriesAndRetainPhase() throws Exception {
        String[][] codes = {{"invalid_api_key", "SPEECH_AUTH"}, {"InvalidApiKey", "SPEECH_AUTH"}, {"Unauthorized", "SPEECH_AUTH"}, {"rate_limit_exceeded", "SPEECH_RATE_LIMIT"}, {"Throttling", "SPEECH_RATE_LIMIT"}, {"unknown_synthetic_error", "SPEECH_PROVIDER"}, {"", "SPEECH_PROVIDER"}};
        for (boolean configuring : new boolean[]{false, true}) {
            for (String[] code : codes) {
                GleamSpeechSessionTest.Fixture f = diagnostic(); if (configuring) GleamSpeechProtocol.receive(f.session, CREATED);
                String raw = new JSONObject().put("event_id", "event_synthetic_error").put("type", "error").put("error", new JSONObject().put("type", "invalid_request_error").put("code", code[0]).put("message", "synthetic provider body must not escape").put("param", "synthetic_param")).toString();
                GleamSpeechProtocol.receive(f.session, raw);
                assertEquals(code[1], f.code); assertEquals(configuring ? "configuring" : "connecting", f.session.phase().value);
                assertEquals(1, f.errors); assertEquals(1, f.closes); assertEquals(0, f.connections); assertEquals(0, f.starts);
                assertNull(f.text);
            }
        }
        GleamSpeechSessionTest.Fixture missing = diagnostic(); GleamSpeechProtocol.receive(missing.session, "{\"type\":\"error\"}"); assertEquals("SPEECH_PROVIDER", missing.code);
    }
    @Test public void cancellationAndCredentialOrBackgroundTeardownWinOverLateSyntheticAcknowledgement() {
        for (String code : new String[]{"SPEECH_CANCELLED", "SPEECH_KEY_CHANGED", "SPEECH_INTERRUPTED"}) {
            GleamSpeechSessionTest.Fixture f = diagnostic(); GleamSpeechProtocol.receive(f.session, CREATED);
            f.session.cancel(code); GleamSpeechProtocol.receive(f.session, UPDATED); GleamSpeechProtocol.receive(f.session, CREATED);
            assertEquals(code, f.code); assertEquals(1, f.errors); assertEquals(0, f.connections); assertEquals(0, f.starts); assertEquals(1, f.sent.size());
        }
    }
}
