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
@androidx.test.filters.SdkSuppress(minSdkVersion = 29)
@RunWith(AndroidJUnit4.class)
public class GleamPermissionRestorationProbeTest {
    @SuppressWarnings("unchecked")
    private static String queueSyntheticPermissionResult(BridgeActivity activity) {
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
            return key;
        } catch (ReflectiveOperationException e) { throw new AssertionError(e); }
    }
    private static boolean savedBundleContainsPending(Bundle bundle, String key) {
        if (bundle == null || key == null) return false;
        Bundle pending = bundle.getBundle("KEY_COMPONENT_ACTIVITY_PENDING_RESULT");
        if (pending != null && pending.containsKey(key)) return true;
        for (String child : bundle.keySet()) {
            Object value = bundle.get(child);
            if (value instanceof Bundle && savedBundleContainsPending((Bundle) value, key)) return true;
        }
        return false;
    }
    private static final class Trace {
        final String host;
        final long started = android.os.SystemClock.elapsedRealtime();
        int sequence;
        int preSaves;
        int saves;
        int postSaves;
        int fixtureSaveEntries;
        int fixtureSaveExits;
        Trace(Class<?> host) { this.host = host.getSimpleName(); }
        synchronized void event(Activity activity, String event, String detail) {
            String identity = activity == null ? "none" : activity.getClass().getSimpleName() + "@"
                + Integer.toHexString(System.identityHashCode(activity));
            String row = (++sequence) + " +" + (android.os.SystemClock.elapsedRealtime() - started)
                + "ms " + host + " " + identity + " " + event + " " + detail;
            android.util.Log.i("BootPermissionProbe", row);
            Bundle status = new Bundle();
            status.putString("permission_trace", row);
            GleamNativeBootLifecycleTest.instrumentation().sendStatus(0, status);
        }
        synchronized void framework(Activity activity, String event, Bundle state, String expectedKey) {
            if ("application.preSave".equals(event)) preSaves++;
            if ("application.save".equals(event)) saves++;
            if ("application.postSave".equals(event)) postSaves++;
            if ("fixture.onSave.entry".equals(event)) fixtureSaveEntries++;
            if ("fixture.onSave.afterSuper".equals(event)) fixtureSaveExits++;
            event(activity, event, "stateIdentity=" + (state == null ? "null" : Integer.toHexString(System.identityHashCode(state)))
                + " queuedKey=" + expectedKey + " hasPending=" + savedBundleContainsPending(state, expectedKey)
                + " keyTypes=" + keyTypes(state));
        }
        synchronized String saveCounts() {
            return "preSave=" + preSaves + " save=" + saves + " postSave=" + postSaves
                + " fixtureEntry=" + fixtureSaveEntries + " fixtureAfterSuper=" + fixtureSaveExits;
        }
    }
    private static String keyTypes(Bundle state) {
        if (state == null) return "null";
        StringBuilder output = new StringBuilder();
        appendKeyTypes(state, "$", 0, output);
        return output.toString();
    }
    private static void appendKeyTypes(Bundle state, String path, int depth, StringBuilder output) {
        if (depth > 12 || output.length() > 9000) { output.append("[bounded]"); return; }
        java.util.List<String> keys = new java.util.ArrayList<>(state.keySet());
        java.util.Collections.sort(keys);
        for (String key : keys) {
            String next = path + "/" + key;
            Object value;
            try { value = state.get(key); }
            catch (RuntimeException failure) { output.append(next).append(":read-error-").append(failure.getClass().getSimpleName()).append(';'); continue; }
            output.append(next).append(':').append(value == null ? "null" : value.getClass().getName());
            if (value instanceof java.util.Collection) output.append("[size=").append(((java.util.Collection<?>) value).size()).append(']');
            output.append(';');
            // Key/type-only diagnostics: never stringify values, Intent payloads or view state.
            if (value instanceof Bundle && !"android:viewHierarchyState".equals(key))
                appendKeyTypes((Bundle) value, next, depth + 1, output);
        }
    }
    @SuppressWarnings("unchecked")
    private static String registryState(BridgeActivity activity) {
        ActivityResultRegistry registry = activity.getActivityResultRegistry();
        Map<String, Integer> keys = (Map<String, Integer>) BootLifecycleFixtureActivity.field(registry, ActivityResultRegistry.class, "keyToRc");
        Map<?, ?> callbacks = (Map<?, ?>) BootLifecycleFixtureActivity.field(registry, ActivityResultRegistry.class, "keyToCallback");
        Object launched = BootLifecycleFixtureActivity.field(registry, ActivityResultRegistry.class, "launchedKeys");
        Bundle pending = (Bundle) BootLifecycleFixtureActivity.field(registry, ActivityResultRegistry.class, "pendingResults");
        return "lifecycle=" + activity.getLifecycle().getCurrentState() + " registry@"
            + Integer.toHexString(System.identityHashCode(registry)) + " registered=" + keys
            + " callbackKeys=" + callbacks.keySet() + " launched=" + launched + " pending=" + keyTypes(pending);
    }
    private static <T extends BridgeActivity> boolean runProbe(Class<T> host) throws Exception {
        BootResultProbePlugin.permissionResults.set(0);
        BootResultProbePlugin.permissionCall = null;
        BootResultProbePlugin.permissionOwner = null;
        Trace trace = new Trace(host);
        java.util.concurrent.atomic.AtomicReference<T> original = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicReference<String> queuedKey = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicBoolean injectionArmed = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.atomic.AtomicBoolean queuedWhileStopped = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.atomic.AtomicBoolean pendingInActualSavedBundle = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.CountDownLatch originalQueuedPostSave = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicBoolean pendingInRecreatedRegistry = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.atomic.AtomicReference<T> recreated = new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.atomic.AtomicBoolean originalRestarted = new java.util.concurrent.atomic.AtomicBoolean();
        android.app.Application application = (android.app.Application)
            GleamNativeBootLifecycleTest.instrumentation().getTargetContext().getApplicationContext();
        BootPermissionTrace.listener = (activity, event, state) -> {
            if (host.isInstance(activity)) trace.framework(activity, event, state, queuedKey.get());
        };
        android.app.Application.ActivityLifecycleCallbacks snapshots = new android.app.Application.ActivityLifecycleCallbacks() {
            private boolean relevant(Activity activity) { return host.isInstance(activity); }
            private void event(Activity activity, String name) { trace.event(activity, name, relevant(activity) ? "probe-host" : "facilitator-or-other-activity"); }
            @Override public void onActivityPreCreated(Activity activity, Bundle state) {
                if (!relevant(activity)) return;
                original.compareAndSet(null, host.cast(activity));
                trace.framework(activity, "application.preCreate", state, queuedKey.get());
            }
            @Override public void onActivityCreated(Activity a, Bundle state) { if (relevant(a)) trace.framework(a, "application.create", state, queuedKey.get()); }
            @Override public void onActivityPostCreated(Activity a, Bundle state) { if (relevant(a)) trace.framework(a, "application.postCreate", state, queuedKey.get()); }
            @Override public void onActivityPreStarted(Activity a) { event(a, "application.preStart"); }
            @Override public void onActivityStarted(Activity a) { event(a, "application.start"); }
            @Override public void onActivityPostStarted(Activity a) { event(a, "application.postStart"); }
            @Override public void onActivityPreResumed(Activity a) { event(a, "application.preResume"); }
            @Override public void onActivityResumed(Activity a) { event(a, "application.resume"); }
            @Override public void onActivityPostResumed(Activity a) { event(a, "application.postResume"); }
            @Override public void onActivityPrePaused(Activity a) { event(a, "application.prePause"); }
            @Override public void onActivityPaused(Activity a) { event(a, "application.pause"); }
            @Override public void onActivityPostPaused(Activity a) { event(a, "application.postPause"); }
            @Override public void onActivityPreStopped(Activity a) { event(a, "application.preStop"); }
            @Override public void onActivityStopped(Activity a) {
                event(a, "application.stop");
                if (a != original.get() || !injectionArmed.get() || queuedKey.get() != null) return;
                trace.event(a, "queue.before", registryState(original.get()));
                assertEquals("inject only after AndroidX removed active callbacks", Lifecycle.State.CREATED,
                    original.get().getLifecycle().getCurrentState());
                queuedKey.set(queueSyntheticPermissionResult(original.get()));
                queuedWhileStopped.set(true);
                trace.event(a, "queue.after", "queuedKey=" + queuedKey.get() + " " + registryState(original.get()));
            }
            @Override public void onActivityPostStopped(Activity a) { event(a, "application.postStop"); }
            @Override public void onActivityPreSaveInstanceState(Activity a, Bundle state) {
                if (relevant(a)) trace.framework(a, "application.preSave", state, queuedKey.get());
            }
            @Override public void onActivitySaveInstanceState(Activity a, Bundle state) {
                if (relevant(a)) trace.framework(a, "application.save", state, queuedKey.get());
            }
            @Override public void onActivityPostSaveInstanceState(Activity a, Bundle state) {
                if (!relevant(a)) return;
                trace.framework(a, "application.postSave", state, queuedKey.get());
                String expectedKey = queuedKey.get();
                boolean originalQueuedSave = a == original.get() && expectedKey != null;
                if (originalQueuedSave) pendingInActualSavedBundle.set(savedBundleContainsPending(state, expectedKey));
                trace.event(a, "registry.atPostSave", registryState(host.cast(a)));
                // Publish actual framework Bundle evidence before releasing the test thread.
                // moveToState(CREATED) may return before Android finishes this postSave callback.
                if (originalQueuedSave) originalQueuedPostSave.countDown();
            }
            @Override public void onActivityPreDestroyed(Activity a) { event(a, "application.preDestroy"); }
            @Override public void onActivityDestroyed(Activity a) { event(a, "application.destroy"); }
            @Override public void onActivityPostDestroyed(Activity a) { event(a, "application.postDestroy"); }
        };
        androidx.test.runner.lifecycle.ActivityLifecycleCallback observer = (activity, stage) -> {
            if (!host.isInstance(activity)) return;
            trace.event(activity, "androidx." + stage, "");
            if (activity == original.get() && queuedWhileStopped.get()
                    && (stage == androidx.test.runner.lifecycle.Stage.RESTARTED
                    || stage == androidx.test.runner.lifecycle.Stage.STARTED
                    || stage == androidx.test.runner.lifecycle.Stage.RESUMED)) originalRestarted.set(true);
            if (activity != original.get() && stage == androidx.test.runner.lifecycle.Stage.CREATED) {
                T replacement = host.cast(activity);
                Bundle pending = (Bundle) BootLifecycleFixtureActivity.field(replacement.getActivityResultRegistry(),
                    ActivityResultRegistry.class, "pendingResults");
                pendingInRecreatedRegistry.set(pending.containsKey(queuedKey.get()));
                trace.event(activity, "registry.atRecreatedCreate", registryState(replacement));
                recreated.set(replacement);
            }
        };
        androidx.test.runner.lifecycle.ActivityLifecycleMonitor monitor =
            androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance();
        application.registerActivityLifecycleCallbacks(snapshots);
        monitor.addLifecycleCallback(observer);
        ActivityScenario<T> scenario = null;
        Throwable primaryFailure = null;
        try {
            trace.event(null, "test.launch.begin", "target=" + host.getName());
            scenario = ActivityScenario.launch(GleamNativeBootLifecycleTest.intent(host));
            scenario.onActivity(activity -> {
                assertSame("preCreate observer must identify original launch", original.get(), activity);
                assertTrue("probe requires framework targetSdk>=P stop-before-save ordering",
                    activity.getApplicationInfo().targetSdkVersion >= android.os.Build.VERSION_CODES.P);
                trace.event(activity, "test.launch.return", "sdk=" + android.os.Build.VERSION.SDK_INT
                    + " target=" + activity.getApplicationInfo().targetSdkVersion + " " + registryState(activity));
            });
            StringBuilder scenarioFields = new StringBuilder();
            String invokerMetadata = "not-observed";
            for (Field field : ActivityScenario.class.getDeclaredFields()) {
                scenarioFields.append(field.getName()).append(':').append(field.getType().getName()).append(';');
                if (!"activityInvoker".equals(field.getName())) continue;
                try {
                    field.setAccessible(true);
                    Object invoker = field.get(scenario);
                    invokerMetadata = invoker == null ? "null" : invoker.getClass().getName();
                } catch (ReflectiveOperationException | RuntimeException unavailable) {
                    invokerMetadata = "optional-read-unavailable:" + unavailable.getClass().getSimpleName();
                }
            }
            trace.event(original.get(), "test.actualActivityInvoker", invokerMetadata + " scenarioFields=" + scenarioFields);
            injectionArmed.set(true);
            trace.event(original.get(), "test.moveCreated.begin", trace.saveCounts());
            scenario.moveToState(Lifecycle.State.CREATED);
            trace.event(original.get(), "test.moveCreated.return", trace.saveCounts() + " queued=" + queuedWhileStopped.get()
                + " savedContains=" + pendingInActualSavedBundle.get());
            assertTrue("onStop did not queue synthetic result before framework save", queuedWhileStopped.get());
            trace.event(original.get(), "test.awaitQueuedPostSave.begin", trace.saveCounts());
            boolean postSaveCompleted = originalQueuedPostSave.await(25, java.util.concurrent.TimeUnit.SECONDS);
            trace.event(original.get(), "test.awaitQueuedPostSave.return", "completed=" + postSaveCompleted
                + " savedContains=" + pendingInActualSavedBundle.get() + " " + trace.saveCounts());
            assertTrue("actual original queued framework postSave callback did not complete: " + trace.saveCounts(), postSaveCompleted);
            assertTrue("actual framework saved Bundle omitted queued AndroidX result: " + trace.saveCounts(), pendingInActualSavedBundle.get());
            assertEquals(0, BootResultProbePlugin.permissionResults.get());
            trace.event(original.get(), "test.directRecreate.begin", trace.saveCounts());
            GleamNativeBootLifecycleTest.ui(() -> original.get().recreate());
            GleamNativeBootLifecycleTest.await("stopped host was not recreated", () -> recreated.get() != null);
            assertFalse("original host restarted before recreation and could consume pending result", originalRestarted.get());
            assertNotSame(original.get(), recreated.get());
            assertTrue("recreated AndroidX registry did not receive pending saved result", pendingInRecreatedRegistry.get());
            scenario.moveToState(Lifecycle.State.RESUMED);
            GleamNativeBootLifecycleTest.await("AndroidX restored permission callback swallowed", () -> BootResultProbePlugin.permissionResults.get() == 1);
            assertSame("callback must target the recreated Activity, not static evidence from old host",
                recreated.get(), BootResultProbePlugin.permissionOwner);
            assertNotSame(original.get(), BootResultProbePlugin.permissionOwner);
            boolean retained = BootResultProbePlugin.permissionCall != null;
            Thread.sleep(250);
            assertEquals("permission callback duplicated", 1, BootResultProbePlugin.permissionResults.get());
            trace.event(recreated.get(), "test.completed", "callbackCount=" + BootResultProbePlugin.permissionResults.get()
                + " callPresent=" + retained + " " + trace.saveCounts());
            return retained;
        } catch (Exception | AssertionError failure) {
            primaryFailure = failure;
            trace.event(original.get(), "test.hardFailure", failure.getClass().getName() + ":" + failure.getMessage() + " callbackCount="
                + BootResultProbePlugin.permissionResults.get() + " callPresent=" + (BootResultProbePlugin.permissionCall != null));
            throw failure;
        } finally {
            trace.event(original.get(), "test.cleanup.begin", trace.saveCounts());
            try { if (scenario != null) scenario.close(); }
            catch (RuntimeException | AssertionError closeFailure) {
                trace.event(original.get(), "test.cleanup.failure", closeFailure.getClass().getName() + ":" + closeFailure.getMessage());
                if (primaryFailure != null) primaryFailure.addSuppressed(closeFailure);
                else throw new AssertionError("ActivityScenario.close failed", closeFailure);
            } finally {
                trace.event(original.get(), "test.cleanup.end", trace.saveCounts());
                monitor.removeLifecycleCallback(observer);
                application.unregisterActivityLifecycleCallbacks(snapshots);
                BootPermissionTrace.listener = null;
            }
        }
    }
    @Test public void pendingPermissionResultMatchesUngatedCapacitorBaselineAndReportsCallRetention() throws Exception {
        BootLifecycleFixtureActivity.holdCleanup = true;
        Boolean baseline = null;
        Boolean gated = null;
        AssertionError baselineFailure = null;
        AssertionError gatedFailure = null;
        try {
            try { baseline = runProbe(BootBaselineFixtureActivity.class); }
            catch (Exception | AssertionError failure) { baselineFailure = failure instanceof AssertionError
                ? (AssertionError) failure : new AssertionError("baseline diagnostic failed", failure); }
            try { gated = runProbe(BootLifecycleFixtureActivity.class); }
            catch (Exception | AssertionError failure) { gatedFailure = failure instanceof AssertionError
                ? (AssertionError) failure : new AssertionError("gated diagnostic failed", failure); }
            Bundle report = new Bundle();
            report.putString("permission_probe_kind", "synthetic_androidx_pending_result_direct_stopped_host_recreation_complete_framework_trace");
            report.putString("baseline_result", baseline == null ? "hard_failure_no_restoration_conclusion" : "call_retained=" + baseline);
            report.putString("gated_result", gated == null ? "hard_failure_no_restoration_conclusion" : "call_retained=" + gated);
            report.putString("baseline_failure", baselineFailure == null ? "none" : baselineFailure.getMessage());
            report.putString("gated_failure", gatedFailure == null ? "none" : gatedFailure.getMessage());
            GleamNativeBootLifecycleTest.instrumentation().sendStatus(0, report);
            if (baselineFailure != null || gatedFailure != null) {
                AssertionError failure = new AssertionError("Synthetic permission prerequisites/restoration failed. baseline="
                    + (baselineFailure == null ? "passed" : baselineFailure.getMessage()) + "; gated="
                    + (gatedFailure == null ? "passed" : gatedFailure.getMessage()));
                if (baselineFailure != null) failure.addSuppressed(baselineFailure);
                if (gatedFailure != null) failure.addSuppressed(gatedFailure);
                throw failure;
            }
            assertEquals("gate must not regress native permission call retention", baseline, gated);
            report.putBoolean("baseline_permission_callback_received_by_new_activity", true);
            report.putBoolean("gated_permission_callback_received_by_new_activity", true);
            report.putBoolean("original_activity_never_restarted_before_recreation", true);
            report.putBoolean("pending_result_verified_in_actual_framework_saved_bundle", true);
            report.putBoolean("pending_result_verified_in_recreated_androidx_registry", true);
            report.putBoolean("baseline_permission_call_retained", baseline);
            report.putBoolean("gated_permission_call_retained", gated);
            report.putString("permission_limitation", gated ? "none_observed_in_synthetic_recreation_probe_not_real_system_permission_or_process_death" :
                "Capacitor callback delivered once with null PluginCall in both hosts; this is NOT full permission restoration acceptance");
            GleamNativeBootLifecycleTest.instrumentation().sendStatus(0, report);
        } finally { BootLifecycleFixtureActivity.holdCleanup = false; }
    }
}
