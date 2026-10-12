package com.gleam.shiguang;

import android.graphics.Color;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.getcapacitor.Bridge;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;

/** Candidate boot quarantine. Never attach a Capacitor Bridge or JS interface to this WebView. */
final class GleamBootGuard {
    private static final long DEADLINE_MS = 15_000;
    // ServiceWorkerController has one client for the process, not one client per WebView.
    private static volatile GleamBootGuard currentOwner;
    private final MainActivity activity;
    private final Bridge bridge;
    private final GleamBootWebView main;
    private final GleamBootState state;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final LinearLayout overlay;
    private final TextView message;
    private final Button retry;
    private WebView quarantine;
    private GleamBootGuard predecessor;
    private Runnable deadline;
    private Runnable poll;
    private volatile boolean resumed;
    private boolean navigationStarted;
    private boolean cleanupStarted;

    GleamBootGuard(MainActivity activity, Bridge bridge, GleamBootWebView main) {
        this.activity = activity;
        this.bridge = bridge;
        this.main = main;
        this.state = main.bootState();
        overlay = new LinearLayout(activity);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setBackgroundColor(Color.WHITE);
        int padding = (int) (24 * activity.getResources().getDisplayMetrics().density);
        overlay.setPadding(padding, padding, padding, padding);
        message = new TextView(activity);
        message.setTextColor(Color.rgb(35, 35, 35));
        message.setTextSize(18);
        message.setGravity(Gravity.CENTER);
        overlay.addView(message);
        retry = new Button(activity);
        retry.setText("重试");
        retry.setMinHeight((int) (48 * activity.getResources().getDisplayMetrics().density));
        retry.setOnClickListener(view -> { if (resumed) start(); });
        overlay.addView(retry);
        ((ViewGroup) main.getParent()).addView(overlay,
            new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        showProgress();
        GleamBootGuard previous = currentOwner;
        currentOwner = this;
        if (previous != null) {
            previous.pause(); // Dispose an older quarantine without restoring its Bridge.
            predecessor = previous;
        }
        restoreBridgeInterceptor(); // CLOSED: deny requests even before onResume.
    }

    void resume() {
        resumed = true;
        if (currentOwner == this && (state.phase() == GleamBootState.Phase.CLOSED || state.phase() == GleamBootState.Phase.PAUSED)) start();
    }

    void pause() {
        resumed = false;
        if (state.phase() != GleamBootState.Phase.RUNNING) return;
        state.pause();
        disposeAllQuarantines();
        restoreBridgeInterceptor();
    }

    void destroy() {
        resumed = false;
        state.destroy();
        disposeAllQuarantines();
        if (currentOwner == this) {
            // Never leave a global interceptor retaining a destroyed Activity/Bridge.
            installClosedInterceptor();
            currentOwner = null;
        }
    }

    /** Called before Bridge construction, which must have automatic SW routing disabled. */
    static void installClosedInterceptor() {
        installInterceptor(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) { return blocked(); }
        });
    }

    private static boolean installInterceptor(ServiceWorkerClient client) {
        try {
            ServiceWorkerController.getInstance().setServiceWorkerClient(client);
            return true;
        } catch (RuntimeException unavailableProvider) { return false; }
    }

    private boolean active(long token) {
        return resumed && currentOwner == this && state.isRunning(token) && !activity.isFinishing() && !activity.isDestroyed();
    }

    private void start() {
        if (currentOwner != this || !resumed || state.isOpen()) return;
        long token = state.begin();
        if (token < 0) return;
        showProgress();
        // Invalidate the old generation before any disposal callbacks. A failed teardown
        // (including a predecessor Activity's quarantine) must never allow a new gate to open.
        if (!disposeAllQuarantines()) { fail(token); return; }
        if (!state.hasInitialLoad() || bridge.getServerUrl() != null || !"https".equals(bridge.getScheme()) || !"localhost".equals(bridge.getHost())) {
            fail(token);
            return;
        }
        navigationStarted = false;
        cleanupStarted = false;
        deadline = () -> fail(token);
        handler.postDelayed(deadline, DEADLINE_MS);
        try {
            WebView view = new WebView(activity);
            quarantine = view;
            view.getSettings().setJavaScriptEnabled(false);
            view.getSettings().setDomStorageEnabled(true);
            view.getSettings().setAllowFileAccess(false);
            view.getSettings().setAllowContentAccess(false);
            view.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
            view.getSettings().setSupportMultipleWindows(false);
            // Supply only an inert root network fallback. An existing worker may serve its
            // cached root instead; JS stays disabled through that normal document load.
            if (!installInterceptor(new ServiceWorkerClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    return active(token) && expectedRoot(request) ? inertRoot() : blocked();
                }
            })) { fail(token); return; }
            view.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    boolean deny = !active(token) || navigationStarted || !expectedRoot(request);
                    if (deny) handler.post(() -> fail(token));
                    return deny;
                }
                @SuppressWarnings("deprecation")
                @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                    boolean deny = !active(token) || navigationStarted || !GleamBootState.ROOT.equals(url);
                    if (deny) handler.post(() -> fail(token));
                    return deny;
                }
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    return active(token) && request.isForMainFrame() && expectedRoot(request) ? inertRoot() : blocked();
                }
                @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                    if (!active(token) || navigationStarted || !GleamBootState.ROOT.equals(url)) { fail(token); return; }
                    navigationStarted = true;
                }
                @Override public void onPageFinished(WebView view, String url) {
                    if (!active(token)) return;
                    if (!navigationStarted || !GleamBootState.ROOT.equals(url)) { fail(token); return; }
                    if (cleanupStarted) return;
                    cleanupStarted = true;
                    runCleanup(token, view);
                }
                @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (request.isForMainFrame()) fail(token);
                }
                @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                    if (request.isForMainFrame()) fail(token);
                }
                @Override public void onReceivedSslError(WebView view, SslErrorHandler ssl, SslError error) {
                    ssl.cancel();
                    fail(token);
                }
                @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                    fail(token);
                    return true;
                }
            });
            // loadDataWithBaseURL is deliberately avoided: it has no SW provider on tested WebView.
            view.loadUrl(GleamBootState.ROOT);
        } catch (RuntimeException error) { fail(token); }
    }

    private static boolean expectedRoot(WebResourceRequest request) {
        return !request.isRedirect() && "GET".equals(request.getMethod()) && GleamBootState.ROOT.equals(request.getUrl().toString());
    }

    private static WebResourceResponse inertRoot() {
        return response("text/html", 200, "OK", "<!doctype html><meta name=gleam-boot-quarantine content=inert><title></title>");
    }
    private static WebResourceResponse blocked() { return response("text/plain", 403, "Forbidden", ""); }
    private static WebResourceResponse response(String mime, int status, String reason, String body) {
        return new WebResourceResponse(mime, "UTF-8", status, reason,
            Collections.singletonMap("Cache-Control", "no-store"),
            new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    /** No storage API except serviceWorker.getRegistrations/unregister is called. */
    static String cleanupScript(String key) {
        return "(()=>{const result={state:'pending'};Object.defineProperty(window,'" + key + "',{value:result});"
            + "(async()=>{if(location.origin!=='https://localhost'||location.href!=='https://localhost/'||!isSecureContext||!navigator.serviceWorker)throw Error('origin');"
            + "const sw=navigator.serviceWorker;const controller=sw.controller;if(controller&&controller.scriptURL!=='https://localhost/sw.js')throw Error('controller');"
            + "const roots=(await sw.getRegistrations()).filter(r=>r.scope==='https://localhost/');"
            + "for(const r of roots){const workers=[r.active,r.waiting,r.installing].filter(Boolean);if(!workers.length||workers.some(w=>w.scriptURL!=='https://localhost/sw.js'))throw Error('foreign-root');}"
            + "for(const r of roots){if(!await r.unregister())throw Error('unregister');}"
            + "if((await sw.getRegistrations()).some(r=>r.scope==='https://localhost/'))throw Error('remaining');result.state='clean';"
            + "})().catch(()=>{result.state='failed';});return 'started';})()";
    }

    private void runCleanup(long token, WebView view) {
        try {
            String key = "__gleamBoot" + UUID.randomUUID().toString().replace("-", "");
            view.getSettings().setJavaScriptEnabled(true);
            view.evaluateJavascript(cleanupScript(key), result -> {
                if (!active(token) || quarantine != view) return;
                if (!"\"started\"".equals(result)) { fail(token); return; }
                poll = new Runnable() {
                    @Override public void run() {
                        if (!active(token) || quarantine != view) return;
                        try {
                            view.evaluateJavascript("window['" + key + "'].state", status -> {
                                if (!active(token) || quarantine != view) return;
                                if ("\"clean\"".equals(status)) finish(token);
                                else if ("\"pending\"".equals(status)) handler.postDelayed(this, 100);
                                else fail(token);
                            });
                        } catch (RuntimeException providerError) { fail(token); }
                    }
                };
                handler.post(poll);
            });
        } catch (RuntimeException providerError) { fail(token); }
    }

    private void finish(long token) {
        if (!active(token)) return;
        // The controlled quarantine client must die before the app navigates.
        if (!disposeAllQuarantines()) { fail(token); return; }
        if (!active(token)) return;
        if (!restoreBridgeInterceptor()) { fail(token); return; }
        if (!main.openAfterCleanup(token)) {
            state.fail(token);
            restoreBridgeInterceptor();
            showFailure();
            return;
        }
        ((ViewGroup) overlay.getParent()).removeView(overlay);
    }

    private void fail(long token) {
        if (currentOwner != this || !state.fail(token)) return;
        disposeAllQuarantines();
        restoreBridgeInterceptor();
        showFailure();
    }

    private void showProgress() {
        message.setText("正在检查启动环境…");
        retry.setVisibility(View.GONE);
    }

    private void showFailure() {
        message.setText("启动检查未完成，请重试。");
        retry.setVisibility(View.VISIBLE);
    }

    private boolean restoreBridgeInterceptor() {
        if (currentOwner != this || state.phase() == GleamBootState.Phase.DESTROYED) return false;
        return installInterceptor(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                // Workers keep executing independently of a JS-disabled/paused document.
                // Failed, paused and closed boots must never reach the real Bridge HTTP proxy.
                if (currentOwner != GleamBootGuard.this || !state.isOpen()) return blocked();
                return bridge.getLocalServer().shouldInterceptRequest(request);
            }
        });
    }

    private boolean disposeAllQuarantines() {
        boolean previousDisposed = predecessor == null || predecessor.disposeAllQuarantines();
        if (previousDisposed) predecessor = null;
        boolean disposed = disposeQuarantine();
        return previousDisposed && disposed;
    }

    private boolean disposeQuarantine() {
        if (deadline != null) handler.removeCallbacks(deadline);
        if (poll != null) handler.removeCallbacks(poll);
        deadline = null;
        poll = null;
        WebView old = quarantine;
        if (old == null) return true;
        quarantine = null; // Teardown callbacks cannot act on a view being disposed.
        // Attempt all teardown steps even when a provider call fails. Keep a failed destroy
        // reachable for retry; never treat an unconfirmed destruction as permission to open.
        try { old.getSettings().setJavaScriptEnabled(false); } catch (RuntimeException ignored) {}
        try { old.stopLoading(); } catch (RuntimeException ignored) {}
        try {
            old.destroy();
            return true;
        } catch (RuntimeException providerError) {
            quarantine = old;
            return false;
        }
    }
}
