package com.gleam.shiguang;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;

/** adb-addressable debug-only host. Dedicated synthetic report, no real user data or service. */
public class BootProcessRestorationFixtureActivity extends MainActivity {
    static final String PREFS = "gleam_boot_process_probe";
    private boolean restoredSyntheticState;
    private boolean listenerInstalled;
    private boolean launchScheduled;
    static SharedPreferences proof(android.content.Context context) { return context.getSharedPreferences(PREFS, MODE_PRIVATE); }
    @Override protected void onCreate(Bundle saved) {
        if (saved == null && getIntent().getBooleanExtra("armSyntheticProcessDeath", false)) {
            proof(this).edit().clear().putInt("original_pid", Process.myPid()).putBoolean("armed", true).commit();
        }
        config = BootFixtureNetworkFence.configuration(this);
        registerPlugin(BootProcessResultProbePlugin.class);
        super.onCreate(saved);
        if (getBridge() != null) BootFixtureNetworkFence.install(getBridge());
        restoredSyntheticState = saved != null && "BootProcessResultProbe".equals(saved.getString("capacitorLastActivityPluginId"));
        if (restoredSyntheticState) {
            BootProcessResultProbePlugin plugin = (BootProcessResultProbePlugin) getBridge().getPlugin("BootProcessResultProbe").getInstance();
            proof(this).edit().putBoolean("saved_bundle_present", true)
                .putBoolean("plugin_restored_before_oncreate_return", plugin.restored)
                .putInt("restored_pid", Process.myPid()).commit();
        }
        Log.i("BootProcessProbe", "created pid=" + Process.myPid() + " restored=" + restoredSyntheticState);
    }
    @Override protected void load() {
        BootFixtureNetworkFence.installDocumentFence(findViewById(com.getcapacitor.android.R.id.webview));
        registerPlugin(BootFixtureHttpPlugin.class);
        registerPlugin(BootFixtureWebDavPlugin.class);
        registerPlugin(BootFixtureAiStreamPlugin.class);
        registerPlugin(BootFixtureSpeechPlugin.class);
        super.load();
    }

    @Override public void onResume() {
        super.onResume();
        if (restoredSyntheticState && !listenerInstalled) {
            listenerInstalled = true;
            Plugin app = getBridge().getPlugin("App").getInstance();
            app.addListener(new PluginCall(null, "ProcessProbeCapture", "capture-process-restored", "addListener",
                    new JSObject().put("eventName", "appRestoredResult")) {
                @Override public void resolve(JSObject result) {
                    SharedPreferences report = proof(BootProcessRestorationFixtureActivity.this);
                    int events = report.getInt("app_restored_events", 0) + 1;
                    boolean payload = "BootProcessResultProbe".equals(result.optString("pluginId"))
                        && result.optJSONObject("data") != null
                        && "actual-process-result".equals(result.optJSONObject("data").optString("value"));
                    report.edit().putInt("app_restored_events", events).putBoolean("app_payload_preserved", payload)
                        .putBoolean("completed", true).commit();
                    Log.i("BootProcessProbe", "complete original=" + report.getInt("original_pid", -1)
                        + " restored=" + report.getInt("restored_pid", -1) + " appEvents=" + events);
                }
            });
        }
        if (!restoredSyntheticState && !launchScheduled && getIntent().getBooleanExtra("armSyntheticProcessDeath", false)) {
            launchScheduled = true;
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (!isFinishing() && !isDestroyed()) {
                    ((BootProcessResultProbePlugin) getBridge().getPlugin("BootProcessResultProbe").getInstance()).launchDelayedResult();
                }
            }, 500);
        }
    }
    @Override public void onSaveInstanceState(Bundle saved) {
        super.onSaveInstanceState(saved);
        if ("BootProcessResultProbe".equals(saved.getString("capacitorLastActivityPluginId"))) {
            proof(this).edit().putBoolean("state_saved", true).commit();
            Log.i("BootProcessProbe", "pending AndroidX/Capacitor state saved pid=" + Process.myPid());
        }
    }
}
