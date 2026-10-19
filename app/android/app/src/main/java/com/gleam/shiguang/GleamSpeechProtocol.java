package com.gleam.shiguang;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import static com.gleam.shiguang.GleamSpeechProtocolReason.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** Allowlisted protocol metadata only; provider messages and bodies never become diagnostics. */
final class GleamSpeechProtocol {
    private GleamSpeechProtocol() {}
    static void receive(GleamSpeechSession engine, String message) {
        if (engine.isClosed()) return;
        if (message == null) { engine.protocolFailure(FRAME_MALFORMED_JSON); return; }
        if (message.length() > GleamSpeechSession.MAX_EVENT_CHARS) { engine.protocolFailure(FRAME_OVERSIZED); return; }
        final JSONObject event;
        try { event = new JSONObject(message); }
        catch (Exception ignored) { engine.protocolFailure(FRAME_MALFORMED_JSON); return; }
        dispatch(engine, event);
    }
    static void receiveBinary(GleamSpeechSession engine) { engine.protocolFailure(FRAME_BINARY); }
    static void dispatch(GleamSpeechSession engine, JSONObject event) {
        if (engine.isClosed()) return;
        try {
            String type = event.optString("type");
            if ("error".equals(type)) { engine.cancel(providerCode(event.optJSONObject("error"))); return; }
            if ("session.created".equals(type)) { engine.sessionCreated(event); return; }
            if ("session.updated".equals(type)) { engine.sessionUpdated(event); return; }
            if ("conversation.item.input_audio_transcription.delta".equals(type)) {
                if (event.opt("text") instanceof String && event.opt("stash") instanceof String) {
                    engine.partial(event.optString("item_id", null), event.optString("text") + event.optString("stash"), event.optInt("content_index", -1));
                }
                return;
            }
            engine.event(type, event.optString("item_id", null), event.optString("transcript", null), event.optInt("content_index", -1));
        } catch (Exception ignored) { engine.protocolFailure(FRAME_PROCESSING_FAILED); }
    }
    /** Describe only checks rejected by the unchanged acceptance predicate below. */
    static List<GleamSpeechProtocolReason> ackReasons(JSONObject event) {
        if (!event.has("session")) return Collections.singletonList(ACK_SESSION_MISSING);
        if (event.isNull("session")) return Collections.singletonList(ACK_SESSION_NULL);
        JSONObject session = event.optJSONObject("session");
        if (session == null) return Collections.singletonList(ACK_SESSION_TYPE);
        if (safeAck(session)) return Collections.emptyList();
        List<GleamSpeechProtocolReason> reasons = new ArrayList<>();
        stringField(session, "model", GleamSpeechTransport.MODEL, null, ACK_MODEL_TYPE, ACK_MODEL_MISMATCH, reasons);
        if (!session.has("turn_detection")) reasons.add(ACK_TURN_DETECTION_MISSING);
        else if (!session.isNull("turn_detection")) reasons.add(session.opt("turn_detection") instanceof JSONObject ? ACK_TURN_DETECTION_MISMATCH : ACK_TURN_DETECTION_TYPE);
        if (!session.has("modalities")) reasons.add(ACK_MODALITIES_MISSING);
        else {
            JSONArray modalities = session.optJSONArray("modalities");
            if (modalities == null) reasons.add(ACK_MODALITIES_TYPE);
            else if (modalities.length() != 1 || !"text".equals(modalities.optString(0))) {
                boolean wrongType = false;
                for (int i = 0; i < modalities.length(); i++) if (!(modalities.opt(i) instanceof String)) { wrongType = true; break; }
                reasons.add(wrongType ? ACK_MODALITIES_TYPE : ACK_MODALITIES_MISMATCH);
            }
        }
        JSONObject transcription = objectField(session, "input_audio_transcription", ACK_TRANSCRIPTION_MISSING, ACK_TRANSCRIPTION_TYPE, reasons);
        if (transcription != null) stringField(transcription, "model", "qwen3-asr-flash-realtime", ACK_TRANSCRIPTION_MODEL_MISSING, ACK_TRANSCRIPTION_MODEL_TYPE, ACK_TRANSCRIPTION_MODEL_MISMATCH, reasons);
        JSONObject audio = objectField(session, "audio", ACK_AUDIO_MISSING, ACK_AUDIO_TYPE, reasons);
        if (audio != null) {
            JSONObject input = objectField(audio, "input", ACK_AUDIO_INPUT_MISSING, ACK_AUDIO_INPUT_TYPE, reasons);
            if (input != null) {
                JSONObject format = objectField(input, "format", ACK_AUDIO_FORMAT_MISSING, ACK_AUDIO_FORMAT_TYPE, reasons);
                if (format != null) {
                    stringField(format, "type", "pcm", ACK_AUDIO_ENCODING_MISSING, ACK_AUDIO_ENCODING_TYPE, ACK_AUDIO_ENCODING_MISMATCH, reasons);
                    numberField(format, "sample_rate", 16000, ACK_SAMPLE_RATE_MISSING, ACK_SAMPLE_RATE_TYPE, ACK_SAMPLE_RATE_MISMATCH, reasons);
                    numberField(format, "channels", 1, null, ACK_CHANNELS_TYPE, ACK_CHANNELS_MISMATCH, reasons);
                    stringField(format, "sample_format", "s16le", null, ACK_SAMPLE_FORMAT_TYPE, ACK_SAMPLE_FORMAT_MISMATCH, reasons);
                    stringField(format, "packing", "interleaved", null, ACK_PACKING_TYPE, ACK_PACKING_MISMATCH, reasons);
                    stringField(format, "channel_layout", "mono", null, ACK_CHANNEL_LAYOUT_TYPE, ACK_CHANNEL_LAYOUT_MISMATCH, reasons);
                }
            }
        }
        if (session.optBoolean("enable_search", false)) reasons.add(session.opt("enable_search") instanceof Boolean ? ACK_SEARCH_ENABLED : ACK_SEARCH_TYPE);
        if (session.has("tools")) {
            JSONArray tools = session.optJSONArray("tools");
            if (tools == null) reasons.add(ACK_TOOLS_TYPE); else if (tools.length() != 0) reasons.add(ACK_TOOLS_NONEMPTY);
        }
        // At most 12 independent failed leaves exist; the shared 24-entry cap is defense in depth.
        return GleamSpeechProtocolReason.bounded(reasons);
    }
    private static JSONObject objectField(JSONObject parent, String key, GleamSpeechProtocolReason missing, GleamSpeechProtocolReason wrongType, List<GleamSpeechProtocolReason> reasons) {
        if (!parent.has(key)) { reasons.add(missing); return null; }
        JSONObject value = parent.optJSONObject(key);
        if (value == null) reasons.add(wrongType);
        return value;
    }
    private static void stringField(JSONObject parent, String key, String expected, GleamSpeechProtocolReason missing, GleamSpeechProtocolReason wrongType, GleamSpeechProtocolReason mismatch, List<GleamSpeechProtocolReason> reasons) {
        if (!parent.has(key)) { if (missing != null) reasons.add(missing); return; }
        if (!expected.equals(parent.optString(key))) reasons.add(parent.opt(key) instanceof String ? mismatch : wrongType);
    }
    private static void numberField(JSONObject parent, String key, int expected, GleamSpeechProtocolReason missing, GleamSpeechProtocolReason wrongType, GleamSpeechProtocolReason mismatch, List<GleamSpeechProtocolReason> reasons) {
        if (!parent.has(key)) { if (missing != null) reasons.add(missing); return; }
        if (parent.optInt(key, -1) != expected) reasons.add(parent.opt(key) instanceof Number ? mismatch : wrongType);
    }
    static boolean safeAck(JSONObject session) {
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
    static String providerCode(JSONObject error) {
        String code = error == null ? "" : error.optString("code");
        if ("invalid_api_key".equals(code) || "InvalidApiKey".equals(code) || "Unauthorized".equals(code)) return "SPEECH_AUTH";
        if ("rate_limit_exceeded".equals(code) || "Throttling".equals(code)) return "SPEECH_RATE_LIMIT";
        return "SPEECH_PROVIDER";
    }
}
