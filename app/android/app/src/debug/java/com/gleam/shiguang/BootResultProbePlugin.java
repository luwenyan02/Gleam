package com.gleam.shiguang;

import android.content.Intent;
import android.os.Bundle;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.MessageHandler;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.concurrent.atomic.AtomicInteger;

/** Installed only by the debug fixture activities, never exported to production MainActivity. */
@CapacitorPlugin(name = "BootResultProbe")
public class BootResultProbePlugin extends Plugin {
    public static final AtomicInteger activityResults = new AtomicInteger();
    public static final AtomicInteger permissionResults = new AtomicInteger();
    public static volatile PluginCall activityCall;
    public static volatile PluginCall permissionCall;
    public static volatile boolean gateClosedAtActivityResult;
    public boolean restored;
    public String restoredMarker;

    public PluginCall syntheticCall(String id) {
        MessageHandler handler = (MessageHandler) BootLifecycleFixtureActivity.field(bridge, Bridge.class, "msgHandler");
        return new PluginCall(handler, "BootResultProbe", id, "syntheticResult",
            new JSObject().put("marker", "original-options"));
    }
    public void launchSyntheticActivity() {
        startActivityForResult(syntheticCall("synthetic-activity"),
            new Intent(getActivity(), BootResultFixtureActivity.class), "activityResult");
    }
    @ActivityCallback private void activityResult(PluginCall call, ActivityResult result) {
        activityCall = call;
        gateClosedAtActivityResult = bridge.getWebView() instanceof GleamBootWebView
            && !((GleamBootWebView) bridge.getWebView()).bootState().isOpen();
        activityResults.incrementAndGet();
        if (call != null) call.resolve(new JSObject().put("value", result.getData() == null
            ? "missing" : result.getData().getStringExtra("synthetic")));
    }
    @PermissionCallback private void permissionResult(PluginCall call) {
        permissionCall = call;
        permissionResults.incrementAndGet();
        // Intentionally do not dereference or resolve null. This reports the inherited
        // Capacitor permission-call restoration limit instead of crashing the test process.
    }
    @Override protected Bundle saveInstanceState() {
        Bundle state = super.saveInstanceState();
        if (state != null) state.putString("fixtureMarker", "native-state-preserved");
        return state;
    }
    @Override protected void restoreState(Bundle state) {
        restored = true;
        restoredMarker = state.getString("fixtureMarker");
    }
}
