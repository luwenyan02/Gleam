package com.gleam.shiguang;

import android.content.Context;
import android.os.Bundle;
import android.util.AttributeSet;
import android.webkit.ValueCallback;
import android.webkit.WebBackForwardList;
import com.getcapacitor.CapacitorWebView;
import java.util.Map;

/** Closed from construction, including calls made before the subclass fields initialize. */
public final class GleamBootWebView extends CapacitorWebView {
    private final GleamBootState bootState = new GleamBootState();

    public GleamBootWebView(Context context, AttributeSet attrs) { super(context, attrs); }

    GleamBootState bootState() { return bootState; }
    private boolean open() { return bootState != null && bootState.isOpen(); }
    private void record(String url) { if (bootState != null) bootState.requestInitialLoad(url); }

    /** No pending document, headers, data, or JS is replayed. Only the fixed app root is loaded. */
    boolean openAfterCleanup(long token) {
        if (!bootState.complete(token)) return false;
        try {
            super.loadUrl(GleamBootState.ROOT);
            return true;
        } catch (RuntimeException error) {
            bootState.closeAfterLoadFailure();
            return false;
        }
    }

    @Override public void loadUrl(String url) {
        if (open()) super.loadUrl(url); else record(url);
    }
    @Override public void loadUrl(String url, Map<String, String> headers) {
        if (open()) super.loadUrl(url, headers);
        // A request with arbitrary headers is never an initial app document.
    }
    @Override public void postUrl(String url, byte[] postData) {
        if (open()) super.postUrl(url, postData);
    }
    @Override public void loadData(String data, String mimeType, String encoding) {
        if (open()) super.loadData(data, mimeType, encoding);
    }
    @Override public void loadDataWithBaseURL(String baseUrl, String data, String mimeType, String encoding, String historyUrl) {
        if (open()) super.loadDataWithBaseURL(baseUrl, data, mimeType, encoding, historyUrl);
    }
    @Override public void evaluateJavascript(String script, ValueCallback<String> callback) {
        if (open()) super.evaluateJavascript(script, callback);
    }
    @Override public void reload() { if (open()) super.reload(); }
    @Override public void goBack() { if (open()) super.goBack(); }
    @Override public void goForward() { if (open()) super.goForward(); }
    @Override public void goBackOrForward(int steps) { if (open()) super.goBackOrForward(steps); }
    @Override public boolean canGoBack() { return open() && super.canGoBack(); }
    @Override public boolean canGoForward() { return open() && super.canGoForward(); }
    @Override public boolean canGoBackOrForward(int steps) { return open() && super.canGoBackOrForward(steps); }
    @Override public WebBackForwardList restoreState(Bundle state) { return open() ? super.restoreState(state) : null; }
    @Override public WebBackForwardList saveState(Bundle state) { return open() ? super.saveState(state) : null; }
}
