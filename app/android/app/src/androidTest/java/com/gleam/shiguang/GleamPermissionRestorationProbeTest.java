package com.gleam.shiguang;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.ActivityResultRegistry;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/**
 * Diagnostic comparison, NOT a real system permission request or process-death test.
 * Seeds one synthetic pending OS permission result into the real AndroidX registry while
 * stopped, saves/recreates the Activity, and uses the actual Capacitor @PermissionCallback.
 * No microphone, notifications, grant/revoke operation, or permission dialog is involved.
 */
@androidx.test.filters.SdkSuppress(minSdkVersion = 26)
@RunWith(AndroidJUnit4.class)
public class GleamPermissionRestorationProbeTest {
    @SuppressWarnings("unchecked")
    private static void queueSyntheticPermissionResult(BridgeActivity activity) {
        try {
            Bridge bridge = activity.getBridge();
            BootResultProbePlugin plugin = (BootResultProbePlugin) bridge.getPlugin("BootResultProbe").getInstance();
            Method save = Bridge.class.getDeclaredMethod("savePermissionCall", PluginCall.class);
            save.setAccessible(true);
            save.invoke(bridge, plugin.syntheticCall("synthetic-permission"));
            Map<String, ActivityResultLauncher<String[]>> launchers = (Map<String, ActivityResultLauncher<String[]>>)
                BootLifecycleFixtureActivity.field(plugin, Plugin.class, "permissionLaunchers");
            Object launcher = launchers.get("permissionResult");
            ActivityResultRegistry registry = activity.getActivityResultRegistry();
            Map<String, Integer> keys = (Map<String, Integer>)
                BootLifecycleFixtureActivity.field(registry, ActivityResultRegistry.class, "keyToRc");
            String key = null;
            for (Class<?> type = launcher.getClass(); type != null; type = type.getSuperclass()) {
                for (Field field : type.getDeclaredFields()) {
                    if (field.getType() != String.class) continue;
                    field.setAccessible(true);
                    String value = (String) field.get(launcher);
                    if (keys.containsKey(value)) key = value;
                }
            }
            assertNotNull("AndroidX launcher key cannot be inspected", key);
            List<String> launched = (List<String>)
                BootLifecycleFixtureActivity.field(registry, ActivityResultRegistry.class, "launchedKeys");
            launched.add(key);
            Intent result = new Intent()
                .putExtra(ActivityResultContracts.RequestMultiplePermissions.EXTRA_PERMISSIONS, new String[0])
                .putExtra(ActivityResultContracts.RequestMultiplePermissions.EXTRA_PERMISSION_GRANT_RESULTS, new int[0]);
            assertTrue(registry.dispatchResult(keys.get(key), Activity.RESULT_OK, result));
            assertEquals("stopped callback must await restoration/start", 0, BootResultProbePlugin.permissionResults.get());
        } catch (ReflectiveOperationException e) { throw new AssertionError(e); }
    }
    private static <T extends BridgeActivity> boolean runProbe(Class<T> host) throws Exception {
        BootResultProbePlugin.permissionResults.set(0);
        BootResultProbePlugin.permissionCall = null;
        BootResultProbePlugin.permissionOwner = null;
        try (ActivityScenario<T> scenario = ActivityScenario.launch(GleamNativeBootLifecycleTest.intent(host))) {
            scenario.moveToState(Lifecycle.State.CREATED);
            java.util.concurrent.atomic.AtomicReference<T> original = new java.util.concurrent.atomic.AtomicReference<>();
            scenario.onActivity(activity -> { original.set(activity); queueSyntheticPermissionResult(activity); });
            java.util.concurrent.atomic.AtomicReference<T> recreated = new java.util.concurrent.atomic.AtomicReference<>();
            java.util.concurrent.atomic.AtomicBoolean originalRestarted = new java.util.concurrent.atomic.AtomicBoolean();
            androidx.test.runner.lifecycle.ActivityLifecycleCallback observer = (activity, stage) -> {
                if (activity == original.get() && (stage == androidx.test.runner.lifecycle.Stage.RESTARTED
                        || stage == androidx.test.runner.lifecycle.Stage.STARTED
                        || stage == androidx.test.runner.lifecycle.Stage.RESUMED)) originalRestarted.set(true);
                if (host.isInstance(activity) && activity != original.get()
                        && stage == androidx.test.runner.lifecycle.Stage.CREATED) recreated.set(host.cast(activity));
            };
            androidx.test.runner.lifecycle.ActivityLifecycleMonitor monitor =
                androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance();
            monitor.addLifecycleCallback(observer);
            try {
                // ActivityScenario.recreate() resumes the ORIGINAL host before recreation, flushing
                // its pending result. Direct framework recreation avoids that false restoration pass.
                GleamNativeBootLifecycleTest.ui(() -> original.get().recreate());
                GleamNativeBootLifecycleTest.await("stopped host was not recreated", () -> recreated.get() != null);
                assertFalse("original host restarted before recreation and could consume pending result", originalRestarted.get());
                assertNotSame(original.get(), recreated.get());
                scenario.moveToState(Lifecycle.State.RESUMED);
                GleamNativeBootLifecycleTest.await("AndroidX restored permission callback swallowed", () -> BootResultProbePlugin.permissionResults.get() == 1);
                assertSame("callback must target the recreated Activity, not static evidence from old host",
                    recreated.get(), BootResultProbePlugin.permissionOwner);
                assertNotSame(original.get(), BootResultProbePlugin.permissionOwner);
                boolean retained = BootResultProbePlugin.permissionCall != null;
                Thread.sleep(250);
                assertEquals("permission callback duplicated", 1, BootResultProbePlugin.permissionResults.get());
                return retained;
            } finally { monitor.removeLifecycleCallback(observer); }
        }
    }
    @Test public void pendingPermissionResultMatchesUngatedCapacitorBaselineAndReportsCallRetention() throws Exception {
        BootLifecycleFixtureActivity.holdCleanup = true;
        try {
            boolean baseline = runProbe(BootBaselineFixtureActivity.class);
            boolean gated = runProbe(BootLifecycleFixtureActivity.class);
            assertEquals("gate must not regress native permission call retention", baseline, gated);
            Bundle report = new Bundle();
            report.putString("permission_probe_kind", "synthetic_androidx_pending_result_direct_stopped_host_recreation_receiver_identity_verified");
            report.putBoolean("baseline_permission_callback_received_by_new_activity", true);
            report.putBoolean("gated_permission_callback_received_by_new_activity", true);
            report.putBoolean("original_activity_never_restarted_before_recreation", true);
            report.putBoolean("baseline_permission_call_retained", baseline);
            report.putBoolean("gated_permission_call_retained", gated);
            report.putString("permission_limitation", gated ? "none_observed_in_synthetic_recreation_probe_not_real_system_permission_or_process_death" :
                "Capacitor callback delivered once with null PluginCall in both hosts; this is NOT full permission restoration acceptance");
            GleamNativeBootLifecycleTest.instrumentation().sendStatus(0, report);
        } finally { BootLifecycleFixtureActivity.holdCleanup = false; }
    }
}
