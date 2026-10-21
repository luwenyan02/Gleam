package com.gleam.shiguang;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Offline test substitute: no AI stream can escape through the native bridge. */
@CapacitorPlugin(name = "GleamAiStream")
public final class BootFixtureAiStreamPlugin extends Plugin {
    @PluginMethod public void start(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_NETWORK_BLOCKED"); }
    @PluginMethod public void read(PluginCall call) { call.reject("SYNTHETIC_FIXTURE_NETWORK_BLOCKED"); }
    @PluginMethod public void cancel(PluginCall call) { call.resolve(); }
}
