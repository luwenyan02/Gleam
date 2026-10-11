package com.gleam.shiguang;

import android.os.Bundle;
import android.webkit.WebView;
import android.widget.FrameLayout;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapacitorWebView;

/** Current native test harness + original historical web bytes; NOT historical native 1.10.5. */
public class BootInstallReplaceBaselineActivity extends BridgeActivity {
    public static volatile BootInstallReplaceBaselineActivity latest;

    /** Defer only Bridge's first fixed-root load until the offline fences are installed. */
    private static final class BaselineWebView extends CapacitorWebView {
        private boolean ready;
        private boolean requested;
        BaselineWebView(android.content.Context context) { super(context, null); }
        @Override public void loadUrl(String url) {
            if (ready) super.loadUrl(url);
            else if (GleamBootState.isCanonicalRoot(url)) requested = true;
        }
        @Override public void loadUrl(String url, java.util.Map<String, String> headers) {
            if (ready) super.loadUrl(url, headers);
        }
        @Override public void evaluateJavascript(String js, android.webkit.ValueCallback<String> callback) {
            if (ready) super.evaluateJavascript(js, callback);
        }
        void startRoot() {
            if (!requested) throw new AssertionError("Baseline Bridge did not request the fixed app root");
            ready = true;
            super.loadUrl(GleamBootState.ROOT);
        }
    }

    @Override protected void onCreate(Bundle saved) {
        config = BootFixtureNetworkFence.configuration(this);
        registerPlugin(GleamSecretsPlugin.class);
        registerPlugin(GleamEntryPlugin.class);
        registerPlugin(BootFixtureHttpPlugin.class);
        registerPlugin(BootFixtureWebDavPlugin.class);
        registerPlugin(BootFixtureSpeechPlugin.class);
        super.onCreate(saved);
        latest = this;
    }

    @Override protected void load() {
        WebView inflated = findViewById(com.getcapacitor.android.R.id.webview);
        if (inflated != null) inflated.destroy();
        FrameLayout container = new FrameLayout(this);
        BaselineWebView view = new BaselineWebView(this);
        view.setId(com.getcapacitor.android.R.id.webview);
        container.addView(view, new FrameLayout.LayoutParams(-1, -1));
        setContentView(container);
        BootFixtureNetworkFence.installDocumentFence(view);
        super.load(); // Original synchronous Bridge. No worker cleanup occurs in this host.
        BootFixtureNetworkFence.install(getBridge());
        view.startRoot();
    }
}
