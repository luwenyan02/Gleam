package com.gleam.shiguang;

import android.os.Bundle;
import com.getcapacitor.Plugin;
import java.lang.reflect.Field;

/** Debug-only host runs the actual MainActivity and inherited AndroidX/Capacitor lifecycle. */
public class BootLifecycleFixtureActivity extends MainActivity {
    public static volatile BootLifecycleFixtureActivity latest;
    public static volatile boolean holdCleanup;
    public static volatile int creations;
    public static volatile boolean bridgeReadyBeforeStart;
    public static volatile boolean restoredBeforeStart;
    public static volatile Bundle originalBundle;
    public static volatile java.util.function.Consumer<android.webkit.WebView> quarantineObserver;

    @Override protected void onCreate(Bundle saved) {
        BootPermissionTrace.emit(this, "fixture.onCreate.entry", saved);
        originalBundle = saved;
        config = BootFixtureNetworkFence.configuration(this);
        registerPlugin(BootResultProbePlugin.class);
        super.onCreate(saved);
        BootPermissionTrace.emit(this, "fixture.onCreate.afterSuper", saved);
        if (getBridge() != null) BootFixtureNetworkFence.install(getBridge());
        latest = this;
        creations++;
        bridgeReadyBeforeStart = getBridge() != null
            && getBridge().getPlugin("BootResultProbe") != null
            && getBridge().getPlugin("GleamSecrets") != null;
        restoredBeforeStart = saved == null || !saved.containsKey("capacitorLastActivityPluginId")
            || ((BootResultProbePlugin) getBridge().getPlugin("BootResultProbe").getInstance()).restored;
    }

    @Override public void onSaveInstanceState(Bundle state) {
        BootPermissionTrace.emit(this, "fixture.onSave.entry", state);
        super.onSaveInstanceState(state);
        BootPermissionTrace.emit(this, "fixture.onSave.afterSuper", state);
    }

    @Override protected void load() {
        BootFixtureNetworkFence.installDocumentFence(findViewById(com.getcapacitor.android.R.id.webview));
        registerPlugin(BootFixtureHttpPlugin.class);
        registerPlugin(BootFixtureWebDavPlugin.class);
        registerPlugin(BootFixtureSpeechPlugin.class);
        super.load();
    }

    @Override public void onResume() {
        super.onResume();
        // Deterministic inspection point: real MainActivity.onResume starts cleanup, then its
        // package-private pause operation invalidates it before WebView posts page callbacks.
        android.webkit.WebView quarantine = (android.webkit.WebView) field(guard(), GleamBootGuard.class, "quarantine");
        if (quarantineObserver != null && quarantine != null) quarantineObserver.accept(quarantine);
        if (holdCleanup) guard().pause();
    }

    GleamBootGuard guard() { return (GleamBootGuard) field(this, MainActivity.class, "bootGuard"); }
    GleamBootWebView mainView() { return (GleamBootWebView) getBridge().getWebView(); }

    static Object field(Object object, Class<?> owner, String name) {
        try { Field f = owner.getDeclaredField(name); f.setAccessible(true); return f.get(object); }
        catch (ReflectiveOperationException e) { throw new AssertionError(e); }
    }
}
