package com.gleam.shiguang;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.MessageHandler;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Synthetic pending result across actual app-process death; installed only by debug host. */
@CapacitorPlugin(name = "BootProcessResultProbe")
public class BootProcessResultProbePlugin extends Plugin {
    public boolean restored;
    public String restoredMarker;
    public void launchDelayedResult() {
        MessageHandler handler = (MessageHandler) BootLifecycleFixtureActivity.field(bridge, Bridge.class, "msgHandler");
        PluginCall call = new PluginCall(handler, "BootProcessResultProbe", "process-original-call", "syntheticProcessResult",
            new JSObject().put("marker", "synthetic-process-options").put("originalPid", Process.myPid()));
        startActivityForResult(call, new Intent(getActivity(), BootProcessResultFixtureActivity.class), "processResult");
    }
    @Override protected Bundle saveInstanceState() {
        Bundle state = super.saveInstanceState();
        if (state != null) state.putString("processMarker", "synthetic-native-process-state");
        return state;
    }
    @Override protected void restoreState(Bundle state) {
        restored = true;
        restoredMarker = state.getString("processMarker");
    }
    @ActivityCallback private void processResult(PluginCall call, ActivityResult result) {
        SharedPreferences report = BootProcessRestorationFixtureActivity.proof(getContext());
        boolean gateClosed = bridge.getWebView() instanceof GleamBootWebView
            && !((GleamBootWebView) bridge.getWebView()).bootState().isOpen();
        boolean options = call != null && "synthetic-process-options".equals(call.getString("marker"))
            && call.getInt("originalPid", -1) == report.getInt("original_pid", -2);
        report.edit().putInt("activity_callbacks", report.getInt("activity_callbacks", 0) + 1)
            .putBoolean("activity_call_retained", call != null)
            .putBoolean("dangling_restored_call", call != null && PluginCall.CALLBACK_ID_DANGLING.equals(call.getCallbackId()))
            .putBoolean("options_preserved", options).putBoolean("native_state_preserved", restored
                && "synthetic-native-process-state".equals(restoredMarker))
            .putBoolean("gate_closed_at_result", gateClosed)
            .putBoolean("result_ok", result.getResultCode() == android.app.Activity.RESULT_OK)
            .putInt("callback_pid", Process.myPid()).commit();
        Log.i("BootProcessProbe", "actual AndroidX callback pid=" + Process.myPid() + " restoredCall="
            + (call != null) + " gateClosed=" + gateClosed);
        if (call != null) call.resolve(new JSObject().put("value", result.getData() == null
            ? "missing" : result.getData().getStringExtra("synthetic")));
    }
}
