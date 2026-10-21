package com.gleam.shiguang;

import android.os.Bundle;
import android.widget.FrameLayout;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapacitorWebView;

/** Original synchronous BridgeActivity baseline with an ordinary, ungated CapacitorWebView. */
public class BootBaselineFixtureActivity extends BridgeActivity {
    @Override protected void onCreate(Bundle saved) {
        BootPermissionTrace.emit(this, "fixture.onCreate.entry", saved);
        config = BootFixtureNetworkFence.configuration(this);
        registerPlugin(BootResultProbePlugin.class);
        super.onCreate(saved);
        BootPermissionTrace.emit(this, "fixture.onCreate.afterSuper", saved);
        if (getBridge() != null) BootFixtureNetworkFence.install(getBridge());
    }
    @Override public void onSaveInstanceState(Bundle state) {
        BootPermissionTrace.emit(this, "fixture.onSave.entry", state);
        super.onSaveInstanceState(state);
        BootPermissionTrace.emit(this, "fixture.onSave.afterSuper", state);
    }

    @Override protected void load() {
        FrameLayout container = new FrameLayout(this);
        CapacitorWebView view = new CapacitorWebView(this, null);
        view.setId(com.getcapacitor.android.R.id.webview);
        container.addView(view, new FrameLayout.LayoutParams(-1, -1));
        setContentView(container);
        BootFixtureNetworkFence.installDocumentFence(view);
        registerPlugin(BootFixtureHttpPlugin.class);
        registerPlugin(BootFixtureWebDavPlugin.class);
        registerPlugin(BootFixtureAiStreamPlugin.class);
        registerPlugin(BootFixtureSpeechPlugin.class);
        super.load();
    }
}
