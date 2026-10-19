package com.gleam.shiguang;

import android.Manifest;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.Collections;
import java.util.List;
import javax.net.ssl.SSLException;
import okhttp3.OkHttpClient;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/** Personal BYOK only. Runtime microphone access follows consent plus one explicit start. */
@CapacitorPlugin(name = "GleamSpeech", permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) })
public final class GleamSpeechPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient client = GleamSpeechTransport.client();
    private final GleamSpeechIdentity identity = new GleamSpeechIdentity();
    private GleamSpeechCredentials credentials;
    private GleamSpeechCandidateGate candidates;
    private volatile Session active;
    private final Runnable mainKeyChanged = () -> {
        if (candidates != null) candidates.cancelAll();
        Session interrupted = active;
        if (interrupted != null) {
            // The caller owns CredentialLock. Detach/cancel the socket now, before it can queue more
            // frames. Never call engine.cancel here: engine -> CredentialLock is the only lock order.
            closeSocket(interrupted);
            main.post(() -> { if (active == interrupted) terminate(interrupted, "SPEECH_KEY_CHANGED"); });
        }
    };
    private Session permissionRequest;
    private volatile boolean foreground = true;
    private volatile boolean destroyed;
    private static final class Session {
        final PluginCall call;
        final String id, revision, region, workspace, model;
        final boolean connectionOnly, candidate;
        boolean resultDelivered;
        GleamSpeechSession.Phase phase = GleamSpeechSession.Phase.VALIDATION;
        volatile WebSocket socket;
        GleamSpeechSession engine;
        GleamSpeechAuthorization authorization;
        Runnable permissionDeadline, commitDeadline;
        Session(PluginCall call, boolean connectionOnly, boolean candidate) {
            this.connectionOnly = connectionOnly; this.candidate = candidate; this.call = call; id = call.getString("sessionId"); revision = call.getString("expectedCredentialRevision");
            region = call.getString("region"); workspace = call.getString("workspace"); model = call.getString("model");
        }
    }
    @Override public void load() {
        credentials = new GleamSpeechCredentials(getContext());
        candidates = new GleamSpeechCandidateGate(credentials, GleamCredentialLock.LOCK);
        GleamCredentialLock.add(mainKeyChanged);
    }
    private JSObject readiness() {
        synchronized (GleamCredentialLock.LOCK) {
            JSObject result = new JSObject(); result.put("supported", true); result.put("hasKey", credentials.hasKey());
            result.put("credentialRevision", credentials.revision()); result.put("mainCredentialRevision", credentials.mainRevision());
            result.put("keySource", credentials.source()); result.put("maskedKey", credentials.maskedKey());
            result.put("hasMainKey", credentials.hasMainKey()); result.put("maskedMainKey", credentials.maskedMainKey());
            GleamSpeechCandidateGate.Config config = credentials.activeConfig();
            if (config != null) {
                JSObject bound = new JSObject(); bound.put("region", config.region); bound.put("workspace", config.workspace); bound.put("model", config.model);
                result.put("activeConfig", bound);
            }
            return result;
        }
    }
    private static JSObject committedReadiness(GleamSpeechCandidateGate.Receipt receipt) {
        JSObject result = new JSObject(); result.put("supported", true); result.put("hasKey", true);
        result.put("credentialRevision", receipt.credentialRevision); result.put("mainCredentialRevision", receipt.mainCredentialRevision);
        result.put("keySource", receipt.keySource); result.put("maskedKey", receipt.maskedKey);
        result.put("hasMainKey", receipt.hasMainKey); result.put("maskedMainKey", receipt.maskedMainKey);
        JSObject config = new JSObject(); config.put("region", receipt.activeConfig.region); config.put("workspace", receipt.activeConfig.workspace); config.put("model", receipt.activeConfig.model);
        result.put("activeConfig", config); return result;
    }
    @Override @PluginMethod public void requestPermissions(PluginCall call) { reject(call, "SPEECH_CONSENT_REQUIRED"); }
    @PluginMethod public void configuration(PluginCall call) { main.post(() -> call.resolve(readiness())); }
    @PluginMethod public void invalidateConfiguration(PluginCall call) {
        main.post(() -> {
            String id = call.getString("configurationId");
            if (!GleamSpeechTransport.validSessionId(id)) { reject(call, "SPEECH_SESSION_INVALID"); return; }
            Session session;
            synchronized (GleamCredentialLock.LOCK) {
                candidates.invalidateConfiguration(id);
                session = active;
                if (session != null && session.candidate) closeSocket(session);
            }
            if (session != null && session.candidate) terminate(session, "SPEECH_CANCELLED");
            call.resolve();
        });
    }
    @PluginMethod public void commitTestedKey(PluginCall call) {
        main.post(() -> {
            synchronized (GleamCredentialLock.LOCK) {
                String id = call.getString("sessionId");
                Session session = active;
                if (session == null || !session.candidate || !session.resultDelivered || !session.id.equals(id)) { reject(call, "SPEECH_SESSION_INVALID"); return; }
                try {
                    GleamSpeechCandidateGate.Receipt receipt = candidates.commit(id, call.getString("candidateToken"), call.getString("expectedCredentialRevision"),
                        call.getString("expectedMainCredentialRevision"), call.getString("configurationId"), foreground, destroyed);
                    end(session); call.resolve(committedReadiness(receipt));
                } catch (GleamSpeechCandidateGate.Failure error) { end(session); reject(call, error.code); }
            }
        });
    }
    @PluginMethod public void start(PluginCall call) { begin(call, false, false); }
    @PluginMethod public void testConnection(PluginCall call) { begin(call, true, false); }
    @PluginMethod public void testCandidate(PluginCall call) { begin(call, true, true); }
    private void begin(PluginCall call, boolean connectionOnly, boolean candidate) {
        main.post(() -> {
            if (destroyed || !foreground) { reject(call, "SPEECH_INTERRUPTED"); return; }
            if (!Boolean.TRUE.equals(call.getBoolean("consent")) || !Boolean.TRUE.equals(call.getBoolean("userInitiated"))) { reject(call, "SPEECH_CONSENT_REQUIRED"); return; }
            Session session = new Session(call, connectionOnly, candidate);
            if (!GleamSpeechTransport.validSessionId(session.id) || identity.isEnded(session.id)) { reject(call, "SPEECH_SESSION_INVALID"); return; }
            if (active != null || permissionRequest != null) { reject(call, "SPEECH_BUSY"); return; }
            try { GleamSpeechTransport.endpoint(session.region, session.workspace, session.model); }
            catch (IllegalArgumentException ignored) { reject(call, "SPEECH_CONFIG_INVALID"); return; }
            synchronized (GleamCredentialLock.LOCK) {
                if (!credentials.revision().equals(session.revision)) { reject(call, "SPEECH_KEY_CHANGED"); return; }
                GleamSpeechCandidateGate.Config config = new GleamSpeechCandidateGate.Config(session.region, session.workspace, session.model);
                if (candidate) {
                    try {
                        candidates.begin(session.id, session.revision, call.getString("expectedMainCredentialRevision"), call.getString("configurationId"),
                            call.getString("keySource"), call.getString("value"), config);
                    } catch (GleamSpeechCandidateGate.Failure error) { reject(call, error.code); return; }
                } else {
                    if (!credentials.hasKey()) { reject(call, "SPEECH_KEY_REQUIRED"); return; }
                    if (!credentials.matchesConfig(config)) { reject(call, "SPEECH_CONFIG_INVALID"); return; }
                }
                if (!identity.reserve(session.id, session.revision, credentials.revision())) { candidates.cancel(session.id); reject(call, "SPEECH_SESSION_INVALID"); return; }
                active = session;
                session.authorization = new GleamSpeechAuthorization(GleamCredentialLock.LOCK,
                    () -> active == session && identity.mayContinue(session.id, credentials.revision(), foreground, destroyed));
            }
            // Short-circuit before even inspecting microphone permission during a diagnostic.
            if (session.connectionOnly || getPermissionState("microphone") == PermissionState.GRANTED) connect(session);
            else {
                session.phase = GleamSpeechSession.Phase.PERMISSION;
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
            // An old OS permission result cannot consume or cancel a newer request.
            if (session == null || session.call != call) return;
            permissionRequest = null;
            if (session.permissionDeadline != null) main.removeCallbacks(session.permissionDeadline);
            if (active != session) return; // A grant after release/cancel/key rotation can never restart capture.
            if (destroyed || !foreground) { terminate(session, "SPEECH_INTERRUPTED"); return; }
            if (getPermissionState("microphone") != PermissionState.GRANTED) { terminate(session, "SPEECH_PERMISSION_DENIED"); return; }
            connect(session);
        });
    }
    private void connect(Session session) {
        if (active != session || destroyed || !foreground) { terminate(session, "SPEECH_INTERRUPTED"); return; }
        if (!credentials.revision().equals(session.revision)) { terminate(session, "SPEECH_KEY_CHANGED"); return; }
        session.phase = GleamSpeechSession.Phase.CONNECTING;
        final String key;
        try {
            synchronized (GleamCredentialLock.LOCK) {
                if (!credentials.revision().equals(session.revision)) throw new GleamSpeechCandidateGate.Failure("SPEECH_KEY_CHANGED");
                key = session.candidate ? candidates.transportKey(session.id) : credentials.readForNativeTransport();
            }
        } catch (GleamSpeechCandidateGate.Failure error) { terminate(session, error.code); return; }
        catch (Exception ignored) { terminate(session, "SPEECH_KEY_STORAGE"); return; }
        if (!GleamSpeechTransport.validKey(key)) { terminate(session, "SPEECH_KEY_REQUIRED"); return; }
        GleamSpeechSession.Transport transport = new GleamSpeechSession.Transport() {
            public boolean send(String message) {
                return session.authorization.send(() -> {
                    WebSocket ws = session.socket;
                    return ws != null && ws.queueSize() <= 128 * 1024 && ws.send(message);
                });
            }
            public void close() { closeSocket(session); }
        };
        GleamSpeechSession.Listener listener = new GleamSpeechSession.Listener() {
            public void state(String value) { main.post(() -> { if (active == session && !session.engine.isClosed()) { JSObject event = new JSObject(); event.put("sessionId", session.id); event.put("state", value); notifyListeners("state", event); } }); }
            public void complete(String text) { main.post(() -> resolve(session, text)); }
            public void partial(String text) {
                main.post(() -> {
                    if (active != session || session.engine.isClosed() || !foreground || destroyed
                        || !credentials.revision().equals(session.revision)) return;
                    JSObject event = new JSObject(); event.put("sessionId", session.id);
                    event.put("state", "listening"); event.put("text", text);
                    notifyListeners("state", event);
                });
            }
            public void connected() { main.post(() -> resolve(session, null)); }
            public void fail(String code) {
                GleamSpeechSession.Phase phase = session.engine.phase();
                List<GleamSpeechProtocolReason> reasons = session.engine.protocolReasons();
                main.post(() -> { if (active != session) return; end(session); reject(session.call, code, phase, reasons); });
            }
        };
        GleamSpeechSession.Clock clock = (ms, work) -> { main.postDelayed(work, ms); return () -> main.removeCallbacks(work); };
        if (session.connectionOnly) {
            session.engine = GleamSpeechSession.connectionTest(transport, listener, clock);
        } else {
            GleamSpeechAudio audio = new GleamSpeechAudio(getContext(), session.authorization, new GleamSpeechAudio.Sink() {
                public void pcm(byte[] pcm, int length) { session.engine.audio(pcm, length); }
                public void failure(String code) { main.post(() -> terminate(session, code)); }
            });
            session.engine = new GleamSpeechSession(transport, audio, listener, clock);
        }
        session.engine.begin();
        try {
            session.authorization.activate(() -> {
            session.socket = client.newWebSocket(GleamSpeechTransport.request(session.region, session.workspace, session.model, key), new WebSocketListener() {
                @Override public void onMessage(WebSocket ws, String message) {
                    if (message.length() > GleamSpeechSession.MAX_EVENT_CHARS) main.post(() -> transportEnded(session, ws, "SPEECH_PROTOCOL", Collections.singletonList(GleamSpeechProtocolReason.FRAME_OVERSIZED)));
                    else main.post(() -> receive(session, ws, message));
                }
                @Override public void onMessage(WebSocket ws, ByteString data) { main.post(() -> transportEnded(session, ws, "SPEECH_PROTOCOL", Collections.singletonList(GleamSpeechProtocolReason.FRAME_BINARY))); }
                @Override public void onClosing(WebSocket ws, int code, String reason) { ws.cancel(); main.post(() -> transportEnded(session, ws, "SPEECH_NETWORK")); }
                @Override public void onClosed(WebSocket ws, int code, String reason) { main.post(() -> transportEnded(session, ws, "SPEECH_NETWORK")); }
                @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                    String code = error instanceof SSLException ? "SPEECH_TLS" : response != null ? GleamSpeechTransport.statusCode(response.code()) : "SPEECH_NETWORK";
                    if (response != null && response.body() != null) response.body().close();
                    main.post(() -> transportEnded(session, ws, code));
                }
            });
            });
        } catch (RuntimeException ignored) { terminate(session, session.authorization.allowed() ? "SPEECH_NETWORK" : "SPEECH_KEY_CHANGED"); }
    }
    private void receive(Session session, WebSocket socket, String message) {
        if (active != session || session.socket != socket || session.engine == null || session.engine.isClosed()) return;
        if (!identity.mayContinue(session.id, credentials.revision(), foreground, destroyed)) {
            terminate(session, credentials.revision().equals(session.revision) ? "SPEECH_INTERRUPTED" : "SPEECH_KEY_CHANGED"); return;
        }
        GleamSpeechProtocol.receive(session.engine, message);
    }
    private void transportEnded(Session session, WebSocket socket, String code) { transportEnded(session, socket, code, Collections.emptyList()); }
    private void transportEnded(Session session, WebSocket socket, String code, List<GleamSpeechProtocolReason> reasons) {
        // finish() deliberately cancels the socket before posting its result.
        // The resulting late close/failure callback must not turn that success into a failure.
        if (active != session || session.socket != socket || session.engine == null || session.engine.isClosed()) return;
        terminate(session, code, reasons);
    }
    private void resolve(Session session, String text) {
        if (active != session) return;
        if (!identity.mayContinue(session.id, credentials.revision(), foreground, destroyed)) {
            terminate(session, credentials.revision().equals(session.revision) ? "SPEECH_INTERRUPTED" : "SPEECH_KEY_CHANGED"); return;
        }
        JSObject result = new JSObject(); result.put("sessionId", session.id);
        if (session.connectionOnly) result.put("connected", true); else result.put("text", text);
        if (session.candidate) {
            try { result.put("candidateToken", candidates.acknowledge(session.id, foreground, destroyed)); }
            catch (GleamSpeechCandidateGate.Failure error) { terminate(session, error.code); return; }
            session.resultDelivered = true;
            session.commitDeadline = () -> terminate(session, "SPEECH_TIMEOUT");
            main.postDelayed(session.commitDeadline, 30000);
        } else end(session);
        session.call.resolve(result);
    }
    @PluginMethod public void stop(PluginCall call) {
        main.post(() -> { String id = call.getString("sessionId"); if (!GleamSpeechTransport.validSessionId(id)) { reject(call, "SPEECH_SESSION_INVALID"); return; }
            Session session = active; if (session != null && session.id.equals(id)) { if (session.engine == null || session.candidate) terminate(session, "SPEECH_CANCELLED"); else session.engine.stop(); } else rememberEnded(id); call.resolve(); });
    }
    @PluginMethod public void cancel(PluginCall call) {
        main.post(() -> { String id = call.getString("sessionId"); if (!GleamSpeechTransport.validSessionId(id)) { reject(call, "SPEECH_SESSION_INVALID"); return; }
            Session session = active; if (session != null && session.id.equals(id)) terminate(session, "SPEECH_CANCELLED"); else rememberEnded(id); call.resolve(); });
    }
    private void cancelActive(String code) { Session session = active; if (session != null) terminate(session, code); }
    private void terminate(Session session, String code) { terminate(session, code, Collections.emptyList()); }
    private void terminate(Session session, String code, List<GleamSpeechProtocolReason> reasons) {
        if (active != session) return;
        GleamSpeechSession.Phase phase = session.engine == null ? session.phase : session.engine.phase();
        if (session.engine != null) session.engine.cancel(code, reasons);
        // Clear identity synchronously: queued successful results cannot win over cancellation.
        end(session); if (!session.resultDelivered) reject(session.call, code, phase, reasons);
    }
    private void end(Session session) {
        candidates.cancel(session.id);
        if (session.commitDeadline != null) main.removeCallbacks(session.commitDeadline);
        if (session.permissionDeadline != null) main.removeCallbacks(session.permissionDeadline);
        if (permissionRequest == session) permissionRequest = null;
        if (active == session) active = null;
        rememberEnded(session.id);
    }
    private void rememberEnded(String id) { identity.end(id); }
    private void closeSocket(Session session) {
        synchronized (GleamCredentialLock.LOCK) {
            WebSocket socket = session.socket; session.socket = null;
            if (socket != null) socket.cancel();
        }
    }
    @Override protected void handleOnResume() { synchronized (GleamCredentialLock.LOCK) { foreground = true; } }
    @Override protected void handleOnPause() {
        synchronized (GleamCredentialLock.LOCK) { foreground = false; if (active != null && active.engine != null) closeSocket(active); }
        if (active != null && active.engine != null) cancelActive("SPEECH_INTERRUPTED");
    }
    @Override protected void handleOnStop() {
        synchronized (GleamCredentialLock.LOCK) { foreground = false; if (active != null) closeSocket(active); }
        cancelActive("SPEECH_INTERRUPTED");
    }
    @Override protected void handleOnDestroy() {
        synchronized (GleamCredentialLock.LOCK) {
            destroyed = true; foreground = false; GleamCredentialLock.remove(mainKeyChanged);
            if (active != null) closeSocket(active);
            if (candidates != null) candidates.cancelAll();
        }
        cancelActive("SPEECH_INTERRUPTED");
        client.dispatcher().executorService().shutdown(); client.connectionPool().evictAll();
    }
    private static void reject(PluginCall call, String code) { reject(call, code, GleamSpeechSession.Phase.VALIDATION); }
    private static void reject(PluginCall call, String code, GleamSpeechSession.Phase phase) { reject(call, code, phase, Collections.emptyList()); }
    private static void reject(PluginCall call, String code, GleamSpeechSession.Phase phase, List<GleamSpeechProtocolReason> reasons) {
        JSObject data = new JSObject(); data.put("phase", phase.value);
        if ("SPEECH_PROTOCOL".equals(code)) {
            List<GleamSpeechProtocolReason> safe = GleamSpeechProtocolReason.bounded(reasons);
            JSArray values = new JSArray();
            for (GleamSpeechProtocolReason reason : safe) values.put(reason.name());
            data.put("reason", safe.get(0).name()); data.put("reasons", values);
        }
        call.reject(safeMessage(code), code, data);
    }
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
