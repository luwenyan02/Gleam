package com.gleam.shiguang;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private GleamBootGuard bootGuard;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        GleamBootGuard.installClosedInterceptor();
        registerPlugin(GleamSecretsPlugin.class);
        registerPlugin(GleamSpeechPlugin.class);
        registerPlugin(GleamWebDavPlugin.class);
        registerPlugin(GleamMailPlugin.class);
        registerPlugin(GleamEntryPlugin.class);
        super.onCreate(savedInstanceState);
        // BridgeActivity registers launchers/plugins and restores native results synchronously.
        // The resource override supplies an already-closed main WebView before Bridge.create().
        if (bridge != null && bridge.getWebView() instanceof GleamBootWebView) {
            bootGuard = new GleamBootGuard(this, bridge, (GleamBootWebView) bridge.getWebView());
        }
    }

    @Override public void onResume() {
        super.onResume();
        if (bootGuard != null) bootGuard.resume();
    }

    @Override public void onPause() {
        if (bootGuard != null) bootGuard.pause();
        super.onPause();
    }

    @Override public void onDestroy() {
        if (bootGuard != null) bootGuard.destroy();
        super.onDestroy();
    }
}
