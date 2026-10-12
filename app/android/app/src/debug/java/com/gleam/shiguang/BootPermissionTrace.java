package com.gleam.shiguang;

import android.app.Activity;
import android.os.Bundle;

/** Optional synthetic permission diagnostics. Never changes, copies or replaces framework state. */
public final class BootPermissionTrace {
    public interface Listener { void record(Activity activity, String event, Bundle frameworkState); }
    public static volatile Listener listener;
    private BootPermissionTrace() {}
    public static void emit(Activity activity, String event, Bundle state) {
        Listener observer = listener;
        if (observer != null) observer.record(activity, event, state);
    }
}
