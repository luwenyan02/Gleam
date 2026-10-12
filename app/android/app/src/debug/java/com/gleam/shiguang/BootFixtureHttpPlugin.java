package com.gleam.shiguang;
import android.webkit.JavascriptInterface;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Debug test boundary: even explicit native Http calls cannot make a connection. */
@CapacitorPlugin(name = "CapacitorHttp")
public class BootFixtureHttpPlugin extends com.getcapacitor.plugin.CapacitorHttp {
    @Override @JavascriptInterface public boolean isEnabled() { return false; }
    @Override @PluginMethod public void request(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_NETWORK_BLOCKED"); }
    @Override @PluginMethod public void get(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_NETWORK_BLOCKED"); }
    @Override @PluginMethod public void post(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_NETWORK_BLOCKED"); }
    @Override @PluginMethod public void put(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_NETWORK_BLOCKED"); }
    @Override @PluginMethod public void patch(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_NETWORK_BLOCKED"); }
    @Override @PluginMethod public void delete(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_NETWORK_BLOCKED"); }
}
