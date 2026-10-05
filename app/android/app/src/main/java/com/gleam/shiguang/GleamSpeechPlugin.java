package com.gleam.shiguang;

import android.Manifest;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import javax.net.ssl.SSLException;
import okhttp3.OkHttpClient;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONArray;
import org.json.JSONObject;

/** Personal BYOK only. Runtime microphone access follows consent plus one explicit start. */
@CapacitorPlugin(name = "GleamSpeech", permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) })
public final class GleamSpeechPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient client = GleamSpeechTransport.client();
    private final GleamSpeechIdentity identity = new GleamSpeechIdentity();
    private GleamSpeechCredentials credentials;
    private volatile Session active;
    private Session permissionRequest;
    private volatile boolean foreground = true;
    private volatile boolean destroyed;
    private static final class Session {
        final PluginCall call;
        final String id, revision, region, workspace, model;
        volatile WebSocket socket;
        GleamSpeechSession engine;
        Runnable permissionDeadline;
        Session(PluginCall call) {
            this.call = call; id = call.getString("sessionId"); revision = call.getString("expectedCredentialRevision");
            region = call.getString("region"); workspace = call.getString("workspace"); model = call.getString("model");
        }
    }
    @Override public void load() { credentials = new GleamSpeechCredentials(getContext()); }
    private JSObject readiness() {
        JSObject result = new JSObject(); result.put("supported", true); result.put("hasKey", credentials.hasKey()); result.put("credentialRevision", credentials.revision()); return result;
    }
    @Override @PluginMethod public void requestPermissions(PluginCall call) { reject(call, "SPEECH_CONSENT_REQUIRED"); }
    @PluginMethod public void configuration(PluginCall call) { main.post(() -> call.resolve(readiness())); }
    @PluginMethod public void setKey(PluginCall call) {
        main.post(() -> {
            String value = call.getString("value");
            if (!GleamSpeechTransport.validKey(value)) { reject(call, "SPEECH_CONFIG_INVALID"); return; }
            cancelActive("SPEECH_KEY_CHANGED");
            try { credentials.set(value); call.resolve(readiness()); }
            catch (Exception ignored) { reject(call, "SPEECH_KEY_STORAGE"); }
        });
    }
    @PluginMethod public void clearKey(PluginCall call) {
        main.post(() -> { cancelActive("SPEECH_KEY_CHANGED"); try { credentials.clear(); call.resolve(readiness()); } catch (Exception ignored) { reject(call, "SPEECH_KEY_STORAGE"); } });
    }
    @PluginMethod public void start(PluginCall call) {
        main.post(() -> {
            if (destroyed || !foreground) { reject(call, "SPEECH_INTERRUPTED"); return; }
            if (!Boolean.TRUE.equals(call.getBoolean("consent")) || !Boolean.TRUE.equals(call.getBoolean("userInitiated"))) { reject(call, "SPEECH_CONSENT_REQUIRED"); return; }
            Session session = new Session(call);
            if (!GleamSpeechTransport.validSessionId(session.id) || identity.isEnded(session.id)) { reject(call, "SPEECH_SESSION_INVALID"); return; }
            if (active != null || permissionRequest != null) { reject(call, "SPEECH_BUSY"); return; }
            try { GleamSpeechTransport.endpoint(session.region, session.workspace, session.model); }
            catch (IllegalArgumentException ignored) { reject(call, "SPEECH_CONFIG_INVALID"); return; }
            if (!credentials.hasKey()) { reject(call, "SPEECH_KEY_REQUIRED"); return; }
            if (!credentials.revision().equals(session.revision)) { reject(call, "SPEECH_KEY_CHANGED"); return; }
            if (!identity.reserve(session.id, session.revision, credentials.revision())) { reject(call, "SPEECH_SESSION_INVALID"); return; }
            active = session;
            if (getPermissionState("microphone") == PermissionState.GRANTED) connect(session);
            else {
                permissionRequest = session;
                session.permissionDeadline = () -> terminate(session, "SPEECH_PERMISSION_CANCELLED");
                main.postDelayed(session.permissionDeadline, 30000);
                requestPermissionForAlias("microphone", call, "microphonePermission");
            }
        });
    }
    @PermissionCallback private void microphonePermission(PluginCall call) {
        main.post(() -> {
            Session session = permissionRequest;
            permissionRequest = null;
            if (session == null) return;
            if (session.permissionDeadline != null) main.removeCallbacks(session.permissionDeadline);
            if (active != session) return; // A grant after release/cancel/key rotation can never restart capture.
            if (session.call != call) { terminate(session, "SPEECH_PERMISSION_CANCELLED"); return; }
            if (destroyed || !foreground) { terminate(session, "SPEECH_INTERRUPTED"); return; }
            if (getPermissionState("microphone") != PermissionState.GRANTED) { terminate(session, "SPEECH_PERMISSION_DENIED"); return; }
            connect(session);
        });
    }
    private void connect(Session session) {
        if (active != session || destroyed || !foreground) { terminate(session, "SPEECH_INTERRUPTED"); return; }
        if (!credentials.revision().equals(session.revision)) { terminate(session, "SPEECH_KEY_CHANGED"); return; }
        final String key;
        try { key = credentials.readForNativeTransport(); }
        catch (Exception ignored) { terminate(session, "SPEECH_KEY_STORAGE"); return; }
        if (!GleamSpeechTransport.validKey(key)) { terminate(session, "SPEECH_KEY_REQUIRED"); return; }
        GleamSpeechSession.Transport transport = new GleamSpeechSession.Transport() {
            public boolean send(String message) { WebSocket ws = session.socket; return ws != null && ws.queueSize() <= 128 * 1024 && ws.send(message); }
            public void close() { WebSocket ws = session.socket; session.socket = null; if (ws != null) ws.cancel(); }
        };
        GleamSpeechAudio audio = new GleamSpeechAudio(getContext(), () -> active == session && identity.mayContinue(session.id, credentials.revision(), foreground, destroyed), new GleamSpeechAudio.Sink() {
            public void pcm(byte[] pcm, int length) { session.engine.audio(pcm, length); }
            public void failure(String code) { main.post(() -> terminate(session, code)); }
        });
        session.engine = new GleamSpeechSession(transport, audio, new GleamSpeechSession.Listener() {
            public void state(String value) { main.post(() -> { if (active == session && !session.engine.isClosed()) { JSObject event = new JSObject(); event.put("sessionId", session.id); event.put("state", value); notifyListeners("state", event); } }); }
            public void complete(String text) { main.post(() -> { if (active != session) return; end(session); JSObject result = new JSObject(); result.put("sessionId", session.id); result.put("text", text); session.call.resolve(result); }); }
            public void fail(String code) { main.post(() -> { if (active != session) return; end(session); reject(session.call, code); }); }
        }, (ms, work) -> { main.postDelayed(work, ms); return () -> main.removeCallbacks(work); });
        session.engine.begin();
        try {
            session.socket = client.newWebSocket(GleamSpeechTransport.request(session.region, session.workspace, session.model, key), new WebSocketListener() {
                @Override public void onMessage(WebSocket ws, String message) {
                    if (message.length() > GleamSpeechSession.MAX_EVENT_CHARS) main.post(() -> terminate(session, "SPEECH_PROTOCOL"));
                    else main.post(() -> receive(session, message));
                }
                @Override public void onMessage(WebSocket ws, ByteString data) { main.post(() -> terminate(session, "SPEECH_PROTOCOL")); }
                @Override public void onClosing(WebSocket ws, int code, String reason) { ws.cancel(); main.post(() -> terminate(session, "SPEECH_NETWORK")); }
                @Override public void onClosed(WebSocket ws, int code, String reason) { main.post(() -> terminate(session, "SPEECH_NETWORK")); }
                @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                    String code = error instanceof SSLException ? "SPEECH_TLS" : response != null ? GleamSpeechTransport.statusCode(response.code()) : "SPEECH_NETWORK";
                    if (response != null && response.body() != null) response.body().close();
                    main.post(() -> terminate(session, code));
                }
            });
        } catch (RuntimeException ignored) { terminate(session, "SPEECH_NETWORK"); }
    }
    private void receive(Session session, String message) {
        if (active != session || session.engine == null || session.engine.isClosed()) return;
        if (message.length() > GleamSpeechSession.MAX_EVENT_CHARS) { terminate(session, "SPEECH_PROTOCOL"); return; }
        try {
            JSONObject event = new JSONObject(message); String type = event.optString("type");
            if ("error".equals(type)) { terminate(session, providerCode(event.optJSONObject("error"))); return; }
            boolean safe = !"session.updated".equals(type) || safeAck(event.optJSONObject("session"));
            session.engine.event(type, event.optString("item_id", null), event.optString("transcript", null), event.optInt("content_index", -1), safe);
        } catch (Exception ignored) { terminate(session, "SPEECH_PROTOCOL"); }
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
    private static String providerCode(JSONObject error) {
        String code = error == null ? "" : error.optString("code");
        if ("invalid_api_key".equals(code) || "InvalidApiKey".equals(code) || "Unauthorized".equals(code)) return "SPEECH_AUTH";
        if ("rate_limit_exceeded".equals(code) || "Throttling".equals(code)) return "SPEECH_RATE_LIMIT";
        return "SPEECH_PROVIDER";
    }
    @PluginMethod public void stop(PluginCall call) {
        main.post(() -> { String id = call.getString("sessionId"); if (!GleamSpeechTransport.validSessionId(id)) { reject(call, "SPEECH_SESSION_INVALID"); return; }
            Session session = active; if (session != null && session.id.equals(id)) { if (session.engine == null) terminate(session, "SPEECH_CANCELLED"); else session.engine.stop(); } else rememberEnded(id); call.resolve(); });
    }
    @PluginMethod public void cancel(PluginCall call) {
        main.post(() -> { String id = call.getString("sessionId"); if (!GleamSpeechTransport.validSessionId(id)) { reject(call, "SPEECH_SESSION_INVALID"); return; }
            Session session = active; if (session != null && session.id.equals(id)) terminate(session, "SPEECH_CANCELLED"); else rememberEnded(id); call.resolve(); });
    }
    private void cancelActive(String code) { Session session = active; if (session != null) terminate(session, code); }
    private void terminate(Session session, String code) {
        if (active != session) return;
        if (session.engine != null) session.engine.cancel(code);
        // Clear identity synchronously: queued successful results cannot win over cancellation.
        end(session); reject(session.call, code);
    }
    private void end(Session session) {
        if (session.permissionDeadline != null) main.removeCallbacks(session.permissionDeadline);
        if (active == session) active = null;
        rememberEnded(session.id);
    }
    private void rememberEnded(String id) { identity.end(id); }
    @Override protected void handleOnResume() { foreground = true; }
    @Override protected void handleOnPause() { foreground = false; if (active != null && active.engine != null) cancelActive("SPEECH_INTERRUPTED"); }
    @Override protected void handleOnStop() { foreground = false; cancelActive("SPEECH_INTERRUPTED"); }
    @Override protected void handleOnDestroy() { destroyed = true; foreground = false; cancelActive("SPEECH_INTERRUPTED"); client.dispatcher().executorService().shutdown(); client.connectionPool().evictAll(); }
    private static void reject(PluginCall call, String code) { call.reject(safeMessage(code), code); }
    private static String safeMessage(String code) {
        switch (code) {
            case "SPEECH_CONSENT_REQUIRED": return "请先确认百炼短语音说明，再点击开始";
            case "SPEECH_KEY_REQUIRED": return "请在 AI 设置配置百炼语音 API Key";
            case "SPEECH_KEY_CHANGED": return "语音 Key 已变更，请重新开始";
            case "SPEECH_KEY_STORAGE": return "语音 Key 无法读取或保存，请重新配置";
            case "SPEECH_PERMISSION_DENIED": return "未获麦克风权限，请在系统设置允许后重试";
            case "SPEECH_PERMISSION_CANCELLED": return "麦克风授权已取消，请重新开始";
            case "SPEECH_BUSY": return "上一段语音尚未结束，请稍后重试";
            case "SPEECH_CONFIG_INVALID": return "请检查百炼语音地域、业务空间与模型配置";
            case "SPEECH_AUTH": return "百炼语音鉴权失败，请检查所选地域的 Key 和业务空间";
            case "SPEECH_RATE_LIMIT": return "百炼语音请求较多，请稍后重试";
            case "SPEECH_LIMIT": return "短语音超过 30 秒上限，请缩短后重试";
            case "SPEECH_TRANSCRIPT_LIMIT": return "转录超过 500 字上限，请分段输入";
            case "SPEECH_AUDIO_EMPTY": return "未识别到内容，请重试或使用文字输入";
            case "SPEECH_TIMEOUT": return "语音连接或转录超时，请检查网络后重试";
            case "SPEECH_TLS": return "百炼安全连接失败，请检查系统时间和网络";
            case "SPEECH_NETWORK": return "百炼语音连接中断，请检查网络后重试";
            case "SPEECH_AUDIO_UNAVAILABLE": return "麦克风暂不可用，请关闭占用麦克风的应用后重试";
            case "SPEECH_INTERRUPTED": return "语音已中断，麦克风已关闭，请重新开始";
            case "SPEECH_CANCELLED": return "本次语音已取消";
            case "SPEECH_SESSION_INVALID": return "本次语音已失效，请重新开始";
            case "SPEECH_TRANSCRIPTION_FAILED": return "百炼转录失败，请重试或使用文字输入";
            default: return "百炼语音配置或服务暂不可用，请检查配置后重试";
        }
    }
}
