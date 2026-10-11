package com.gleam.shiguang;

import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.webkit.*;
import com.getcapacitor.Bridge;
import java.io.ByteArrayInputStream;
import java.util.Collections;

/** Debug-only network fence: preserves real Bridge callbacks and never falls back to network. */
final class BootFixtureNetworkFence {
    private static boolean local(Uri url) {
        return "https".equals(url.getScheme()) && "localhost".equals(url.getHost())
            && (url.getPort() == -1 || url.getPort() == 443) && url.getUserInfo() == null;
    }
    private static WebResourceResponse denied() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Fixture network blocked",
            Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
    }
    private static WebResourceResponse asset(Bridge bridge, WebResourceRequest request) {
        String path = request.getUrl().getPath();
        if (!local(request.getUrl()) || (path != null && (path.startsWith(Bridge.CAPACITOR_HTTP_INTERCEPTOR_START)
                || path.startsWith("/_capacitor_https_interceptor_")))) return denied();
        WebResourceResponse result = bridge.getLocalServer().shouldInterceptRequest(request);
        return result == null ? denied() : result;
    }
    @SuppressWarnings("unchecked")
    static com.getcapacitor.CapConfig configuration(android.content.Context context) {
        com.getcapacitor.CapConfig config = com.getcapacitor.CapConfig.loadDefault(context);
        // Keep the generated origin, SW routing and all unrelated configuration exactly intact.
        // Only the test HTTP adapter is disabled before Bridge initialization.
        org.json.JSONObject httpConfig = (org.json.JSONObject) BootLifecycleFixtureActivity.field(
            config.getPluginConfiguration("CapacitorHttp"), com.getcapacitor.PluginConfig.class, "config");
        try { httpConfig.put("enabled", false); }
        catch (org.json.JSONException failure) { throw new AssertionError(failure); }
        return config;
    }
    static void install(Bridge bridge) {
        WebView view = bridge.getWebView();
        WebViewClient delegate = view.getWebViewClient();
        view.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return asset(bridge, r); }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !local(r.getUrl()) || delegate.shouldOverrideUrlLoading(v, r);
            }
            @SuppressWarnings("deprecation") @Override public boolean shouldOverrideUrlLoading(WebView v, String u) {
                return !local(Uri.parse(u)) || delegate.shouldOverrideUrlLoading(v, u);
            }
            @Override public void onPageStarted(WebView v, String u, Bitmap icon) {
                // First current-main page starts only after the production gate opens. Until
                // this point leave the production CLOSED/RUNNING/PAUSED/FAILED SW client intact.
                if (!(v instanceof GleamBootWebView) || ((GleamBootWebView) v).bootState().isOpen()) {
                    ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                        @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest r) {
                            if (v instanceof GleamBootWebView && !((GleamBootWebView) v).bootState().isOpen()) return denied();
                            return asset(bridge, r);
                        }
                    });
                }
                delegate.onPageStarted(v, u, icon);
            }
            @Override public void onPageFinished(WebView v, String u) { delegate.onPageFinished(v, u); }
            @Override public void onPageCommitVisible(WebView v, String u) { delegate.onPageCommitVisible(v, u); }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) { delegate.onReceivedError(v, r, e); }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse e) { delegate.onReceivedHttpError(v, r, e); }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) { delegate.onReceivedSslError(v, h, e); }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) { return delegate.onRenderProcessGone(v, d); }
        });
    }
}
