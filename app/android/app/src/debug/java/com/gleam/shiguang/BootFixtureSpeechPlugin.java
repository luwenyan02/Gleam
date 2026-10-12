package com.gleam.shiguang;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/** Debug test substitute: no microphone request or realtime provider connection. */
@CapacitorPlugin(name = "GleamSpeech", permissions = {
    @Permission(alias = "microphone", strings = {android.Manifest.permission.RECORD_AUDIO})
})
public class BootFixtureSpeechPlugin extends Plugin {
    @PluginMethod public void start(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_NETWORK_BLOCKED"); }
    @Override @PluginMethod public void requestPermissions(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_PERMISSION_BLOCKED"); }
    @PluginMethod public void configuration(PluginCall call) {
        call.resolve(new JSObject().put("supported", false).put("hasKey", false).put("hasMainKey", false));
    }
    @PluginMethod public void setKey(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_CREDENTIAL_BLOCKED"); }
    @PluginMethod public void clearKey(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_CREDENTIAL_BLOCKED"); }
    @PluginMethod public void stop(PluginCall call) { call.resolve(); }
    @PluginMethod public void cancel(PluginCall call) { call.resolve(); }
}
