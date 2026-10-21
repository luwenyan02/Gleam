package com.gleam.shiguang;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/** AI-only HTTPS JSON POST bridge. Each JS pull owns at most one 8KiB raw-byte read. */
@CapacitorPlugin(name = "GleamAiStream")
public final class GleamAiStreamPlugin extends Plugin {
    private static final int MAX_ACTIVE = 4;
    private final Object lock = new Object();
    private final OkHttpClient client = GleamAiStreamSession.client();
    private final Map<String, GleamAiStreamSession> active = new HashMap<>();
    private final LinkedHashMap<String, Long> cancelled = new LinkedHashMap<>();
    private final ThreadPoolExecutor readers = new ThreadPoolExecutor(MAX_ACTIVE, MAX_ACTIVE, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(MAX_ACTIVE));
    private final ScheduledThreadPoolExecutor clock = new ScheduledThreadPoolExecutor(1);
    private boolean destroyed;

    public GleamAiStreamPlugin() { clock.setRemoveOnCancelPolicy(true); readers.allowCoreThreadTimeOut(true); }

    private static boolean validId(String id) { return id != null && id.matches("[A-Za-z0-9-]{8,80}"); }
    private static void reject(PluginCall call, String code) { call.reject("AI 流式请求失败，请重试", code); }

    private void rememberCancellation(String id) {
        long now = System.nanoTime();
        Iterator<Map.Entry<String, Long>> iterator = cancelled.entrySet().iterator();
        while (iterator.hasNext()) if (now - iterator.next().getValue() > TimeUnit.MILLISECONDS.toNanos(GleamAiStreamSession.TIMEOUT_MS)) iterator.remove();
        cancelled.put(id, now);
        while (cancelled.size() > 128) cancelled.remove(cancelled.keySet().iterator().next());
    }

    private void remove(String id, GleamAiStreamSession session, String reason) {
        synchronized (lock) { if (active.get(id) == session) active.remove(id); }
        session.close(reason);
    }

    @PluginMethod public void start(PluginCall pluginCall) {
        String id = pluginCall.getString("id");
        if (!validId(id) || !getConfig().getBoolean("enabled", true)) { reject(pluginCall, "INVALID_REQUEST"); return; }
        final Request request;
        try { request = GleamAiStreamSession.request(pluginCall.getString("url"), pluginCall.getString("authorization"), pluginCall.getString("body")); }
        catch (RuntimeException invalid) { reject(pluginCall, "INVALID_REQUEST"); return; }
        Call call = client.newCall(request);
        GleamAiStreamSession session = new GleamAiStreamSession(call);
        synchronized (lock) {
            if (destroyed || cancelled.remove(id) != null || active.containsKey(id) || active.size() >= MAX_ACTIVE) {
                call.cancel(); reject(pluginCall, "ABORTED_OR_BUSY"); return;
            }
            active.put(id, session);
            // This also removes dormant sessions when JS is frozen and never pulls again.
            session.deadline(clock.schedule(() -> remove(id, session, "TIMEOUT"), GleamAiStreamSession.TIMEOUT_MS, TimeUnit.MILLISECONDS));
        }
        call.enqueue(new Callback() {
            @Override public void onFailure(Call failed, IOException error) {
                String code = session.reason(); remove(id, session, code == null ? "NETWORK" : code);
                reject(pluginCall, code == null ? "NETWORK" : code);
            }
            @Override public void onResponse(Call completed, Response response) {
                String contentType = response.header("Content-Type", "");
                JSObject result = new JSObject().put("status", response.code()).put("contentType", contentType);
                if (!response.isSuccessful() || response.code() == 204 || response.code() == 205) {
                    // Never read private remote error bodies.
                    remove(id, session, "HTTP_STATUS");
                    try { response.close(); } catch (RuntimeException ignored) {}
                    pluginCall.resolve(result); return;
                }
                if (!session.attach(response)) { reject(pluginCall, "ABORTED"); return; }
                pluginCall.resolve(result);
            }
        });
    }

    @PluginMethod public void read(PluginCall pluginCall) {
        String id = pluginCall.getString("id");
        final GleamAiStreamSession session;
        synchronized (lock) { session = id == null ? null : active.get(id); }
        if (session == null) { reject(pluginCall, "STREAM_CLOSED"); return; }
        try {
            readers.execute(() -> {
                try {
                    byte[] chunk = session.read();
                    JSObject result = new JSObject().put("done", chunk == null);
                    if (chunk != null) result.put("dataBase64", Base64.encodeToString(chunk, Base64.NO_WRAP));
                    else remove(id, session, "EOF");
                    pluginCall.resolve(result);
                } catch (IOException error) {
                    remove(id, session, session.reason() == null ? "NETWORK" : session.reason());
                    reject(pluginCall, "STREAM_CLOSED");
                }
            });
        } catch (RejectedExecutionException full) { remove(id, session, "BUSY"); reject(pluginCall, "BUSY"); }
    }

    @PluginMethod public void cancel(PluginCall pluginCall) {
        String id = pluginCall.getString("id");
        if (!validId(id)) { pluginCall.resolve(); return; }
        final GleamAiStreamSession session;
        synchronized (lock) { session = active.get(id); if (session == null) rememberCancellation(id); }
        if (session != null) remove(id, session, "ABORTED");
        pluginCall.resolve();
    }

    @Override protected void handleOnDestroy() {
        Map<String, GleamAiStreamSession> remaining;
        synchronized (lock) { destroyed = true; remaining = new HashMap<>(active); active.clear(); cancelled.clear(); }
        for (Map.Entry<String, GleamAiStreamSession> entry : remaining.entrySet()) remove(entry.getKey(), entry.getValue(), "DESTROYED");
        clock.shutdownNow(); readers.shutdownNow(); client.connectionPool().evictAll();
        super.handleOnDestroy();
    }
}
