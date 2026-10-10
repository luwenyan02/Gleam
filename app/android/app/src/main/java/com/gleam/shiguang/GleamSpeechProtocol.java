package com.gleam.shiguang;

import org.json.JSONArray;
import org.json.JSONObject;

/** Allowlisted protocol metadata only; provider messages and bodies never become diagnostics. */
final class GleamSpeechProtocol {
    private GleamSpeechProtocol() {}
    static void receive(GleamSpeechSession engine, String message) {
        if (engine.isClosed()) return;
        if (message == null || message.length() > GleamSpeechSession.MAX_EVENT_CHARS) { engine.cancel("SPEECH_PROTOCOL"); return; }
        try {
            JSONObject event = new JSONObject(message);
            String type = event.optString("type");
            if ("error".equals(type)) { engine.cancel(providerCode(event.optJSONObject("error"))); return; }
            boolean safe = !"session.updated".equals(type) || safeAck(event.optJSONObject("session"));
            engine.event(type, event.optString("item_id", null), event.optString("transcript", null), event.optInt("content_index", -1), safe);
        } catch (Exception ignored) { engine.cancel("SPEECH_PROTOCOL"); }
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
