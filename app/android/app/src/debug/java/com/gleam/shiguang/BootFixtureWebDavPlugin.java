package com.gleam.shiguang;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Debug test substitute: no backup request can reach a real provider. */
@CapacitorPlugin(name = "GleamWebDav")
public class BootFixtureWebDavPlugin extends Plugin {
    @PluginMethod public void request(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_NETWORK_BLOCKED"); }
    @PluginMethod public void cancel(PluginCall call) { call.resolve(); }
}
