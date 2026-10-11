package com.gleam.shiguang;

import android.app.Instrumentation;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real AndroidX lifecycle/Capacitor integration. Recreation is NOT a process-death test. */
@androidx.test.filters.SdkSuppress(minSdkVersion = 26)
@RunWith(AndroidJUnit4.class)
public class GleamNativeBootLifecycleTest {
    static Instrumentation instrumentation() { return InstrumentationRegistry.getInstrumentation(); }
    static void ui(Runnable action) { instrumentation().runOnMainSync(action); }
    static Intent intent(Class<?> activity) {
        return new Intent(instrumentation().getTargetContext(), activity).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }
    interface Condition { boolean ready(); }
    static void await(String description, Condition condition) throws Exception {
        long end = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(25);
        do { if (condition.ready()) return; Thread.sleep(50); } while (System.nanoTime() < end);
        fail(description);
    }
    static BootResultProbePlugin probe(BootLifecycleFixtureActivity activity) {
        return (BootResultProbePlugin) activity.getBridge().getPlugin("BootResultProbe").getInstance();
    }
    static final class CapturingListener extends PluginCall {
        final List<JSObject> received = new ArrayList<>();
        CapturingListener(String event) { super(null, "capture", "capture-" + event, "addListener", new JSObject().put("eventName", event)); }
        @Override public void resolve(JSObject value) { received.add(value); }
    }
    static CapturingListener consume(Plugin plugin, String event) {
        CapturingListener listener = new CapturingListener(event);
        plugin.addListener(listener);
        return listener;
    }
    private static android.webkit.WebResourceRequest syntheticRequest(String url) {
        return new android.webkit.WebResourceRequest() {
            @Override public Uri getUrl() { return Uri.parse(url); }
            @Override public boolean isForMainFrame() { return false; }
            @Override public boolean isRedirect() { return false; }
            @Override public boolean hasGesture() { return false; }
            @Override public String getMethod() { return "GET"; }
            @Override public java.util.Map<String, String> getRequestHeaders() { return java.util.Collections.emptyMap(); }
        };
    }
    @Before public void prepare() {
        BootLifecycleFixtureActivity.holdCleanup = true;
        BootLifecycleFixtureActivity.creations = 0;
        BootResultProbePlugin.activityResults.set(0);
        BootResultProbePlugin.permissionResults.set(0);
        BootResultProbePlugin.activityCall = null;
        BootResultProbePlugin.permissionCall = null;
    }
    @After public void release() {
        ui(() -> { if (BootResultFixtureActivity.latest != null) BootResultFixtureActivity.latest.finish(); });
        BootLifecycleFixtureActivity.holdCleanup = false;
    }

    @Test public void bridgeRegistersSynchronouslyAndRecreationUsesOriginalSavedState() throws Exception {
        try (ActivityScenario<BootLifecycleFixtureActivity> scenario = ActivityScenario.launch(intent(BootLifecycleFixtureActivity.class))) {
            scenario.onActivity(activity -> {
                assertTrue(BootLifecycleFixtureActivity.bridgeReadyBeforeStart);
                assertTrue(activity.getBridge().getPlugin("CapacitorHttp").getInstance() instanceof BootFixtureHttpPlugin);
                assertTrue(activity.getBridge().getPlugin("GleamWebDav").getInstance() instanceof BootFixtureWebDavPlugin);
                assertTrue(activity.getBridge().getPlugin("GleamSpeech").getInstance() instanceof BootFixtureSpeechPlugin);
                assertFalse(activity.getBridge().getConfig().getPluginConfiguration("CapacitorHttp").getBoolean("enabled", true));
                assertFalse(((BootFixtureHttpPlugin) activity.getBridge().getPlugin("CapacitorHttp").getInstance()).isEnabled());
                for (String url : new String[] {"https://example.invalid/never-contact",
                        "https://localhost/_capacitor_http_interceptor_?u=https%3A%2F%2Fexample.invalid",
                        "https://localhost/_capacitor_https_interceptor_?u=https%3A%2F%2Fexample.invalid"}) {
                    android.webkit.WebResourceResponse denied = activity.mainView().getWebViewClient()
                        .shouldInterceptRequest(activity.mainView(), syntheticRequest(url));
                    assertNotNull(denied);
                    assertEquals(403, denied.getStatusCode());
                }
                assertTrue(activity.mainView().bootState().hasInitialLoad());
                assertFalse(activity.mainView().bootState().isOpen());
                assertNull(activity.mainView().getUrl());
            });
            BootLifecycleFixtureActivity first = BootLifecycleFixtureActivity.latest;
            scenario.recreate();
            scenario.onActivity(activity -> {
                assertNotSame(first, activity);
                assertNotNull(BootLifecycleFixtureActivity.originalBundle);
                assertTrue(BootLifecycleFixtureActivity.bridgeReadyBeforeStart);
                assertTrue(BootLifecycleFixtureActivity.restoredBeforeStart);
                assertEquals(GleamBootState.Phase.DESTROYED, first.mainView().bootState().phase());
                assertNull(activity.mainView().getUrl());
            });
            int creations = BootLifecycleFixtureActivity.creations;
            BootLifecycleFixtureActivity.holdCleanup = false;
            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.moveToState(Lifecycle.State.RESUMED);
            await("real cleanup did not open current app", () -> BootLifecycleFixtureActivity.latest.mainView().bootState().isOpen());
            assertEquals("guard must not recreate Activity", creations, BootLifecycleFixtureActivity.creations);
        }
    }

    @Test public void quarantineFailureRetryAndLateGenerationKeepMainClosed() throws Exception {
        AtomicBoolean droppedJavascriptCallback = new AtomicBoolean();
        try (ActivityScenario<BootLifecycleFixtureActivity> scenario = ActivityScenario.launch(intent(BootLifecycleFixtureActivity.class))) {
            scenario.onActivity(activity -> {
                GleamBootGuard guard = activity.guard();
                activity.mainView().evaluateJavascript("window.__mustNeverReplay=1", ignored -> droppedJavascriptCallback.set(true));
                guard.resume();
                WebView old = (WebView) BootLifecycleFixtureActivity.field(guard, GleamBootGuard.class, "quarantine");
                assertNotNull(old);
                assertFalse(old.getSettings().getJavaScriptEnabled());
                assertFalse(old.getSettings().getAllowFileAccess());
                assertFalse(old.getSettings().getAllowContentAccess());
                assertFalse(old.getSettings().getJavaScriptCanOpenWindowsAutomatically());
                assertFalse(old.getSettings().supportMultipleWindows());
                WebViewClient staleClient = old.getWebViewClient();
                Runnable staleDeadline = (Runnable) BootLifecycleFixtureActivity.field(guard, GleamBootGuard.class, "deadline");
                guard.pause();
                assertEquals(GleamBootState.Phase.PAUSED, activity.mainView().bootState().phase());
                assertNull(BootLifecycleFixtureActivity.field(guard, GleamBootGuard.class, "quarantine"));
                staleClient.onPageFinished(old, GleamBootState.ROOT);
                staleDeadline.run();
                assertEquals(GleamBootState.Phase.PAUSED, activity.mainView().bootState().phase());
                guard.resume();
                Runnable deadline = (Runnable) BootLifecycleFixtureActivity.field(guard, GleamBootGuard.class, "deadline");
                deadline.run(); // Exact production timeout path, accelerated without waiting 15 seconds.
                assertEquals(GleamBootState.Phase.FAILED, activity.mainView().bootState().phase());
                assertNull(activity.mainView().getUrl());
                assertFalse(droppedJavascriptCallback.get());
                Button retry = (Button) BootLifecycleFixtureActivity.field(guard, GleamBootGuard.class, "retry");
                assertTrue(retry.isShown());
                assertTrue(retry.performClick());
                staleClient.onPageFinished(old, GleamBootState.ROOT);
                deadline.run();
                assertEquals(GleamBootState.Phase.RUNNING, activity.mainView().bootState().phase());
            });
            await("retry did not complete real WebView cleanup", () -> BootLifecycleFixtureActivity.latest.mainView().bootState().isOpen());
            assertFalse("dropped JavaScript must never be replayed", droppedJavascriptCallback.get());
            assertEquals("cleanup must not recreate Activity", 1, BootLifecycleFixtureActivity.creations);
        }
    }

    @Test public void coldShareAndDeepLinkRetainOnceUntilNativeListenerRegistration() {
        Intent launch = intent(BootLifecycleFixtureActivity.class).setAction(Intent.ACTION_SEND)
            .setType("text/plain").putExtra(Intent.EXTRA_TEXT, "synthetic shared note");
        try (ActivityScenario<BootLifecycleFixtureActivity> scenario = ActivityScenario.launch(launch)) {
            scenario.onActivity(activity -> {
                assertNull(activity.mainView().getUrl());
                Plugin share = activity.getBridge().getPlugin("CapacitorShareTarget").getInstance();
                CapturingListener listener = consume(share, "shareReceived");
                assertEquals(1, listener.received.size());
                assertEquals("synthetic shared note", listener.received.get(0).optJSONArray("texts").optString(0));
                assertEquals(0, consume(share, "shareReceived").received.size());
                Intent link = new Intent(Intent.ACTION_VIEW, Uri.parse("shiguang://entry?synthetic=gate"));
                instrumentation().callActivityOnNewIntent(activity, link);
                Plugin app = activity.getBridge().getPlugin("App").getInstance();
                CapturingListener links = consume(app, "appUrlOpen");
                assertEquals(1, links.received.size());
                assertEquals(link.getData().toString(), links.received.get(0).optString("url"));
                assertEquals(0, consume(app, "appUrlOpen").received.size());
                assertNull(activity.mainView().getUrl());
            });
        }
        try (ActivityScenario<BootLifecycleFixtureActivity> scenario = ActivityScenario.launch(
                intent(BootLifecycleFixtureActivity.class).setAction(Intent.ACTION_VIEW)
                    .setData(Uri.parse("shiguang://entry?synthetic=cold")))) {
            scenario.onActivity(activity -> {
                assertEquals("shiguang://entry?synthetic=cold", activity.getBridge().getIntentUri().toString());
                assertEquals(1, consume(activity.getBridge().getPlugin("App").getInstance(), "appUrlOpen").received.size());
            });
        }
    }

    @Test public void actualAndroidActivityResultSurvivesHostRecreationAndRetainsAppResultOnce() throws Exception {
        try (ActivityScenario<BootLifecycleFixtureActivity> scenario = ActivityScenario.launch(intent(BootLifecycleFixtureActivity.class))) {
            scenario.onActivity(activity -> probe(activity).launchSyntheticActivity());
            await("synthetic result Activity not launched", () -> BootResultFixtureActivity.latest != null);
            BootLifecycleFixtureActivity original = BootLifecycleFixtureActivity.latest;
            // Result Activity is on top. Recreate host through Android, not scenario.recreate(),
            // whose RESUMED wait would block while the result Activity intentionally remains open.
            ui(original::recreate);
            await("host not recreated beneath pending real Activity result", () -> BootLifecycleFixtureActivity.latest != original);
            BootLifecycleFixtureActivity restored = BootLifecycleFixtureActivity.latest;
            ui(() -> {
                assertNotNull(BootLifecycleFixtureActivity.originalBundle);
                assertTrue(BootLifecycleFixtureActivity.restoredBeforeStart);
                assertTrue(probe(restored).restored);
                assertEquals("native-state-preserved", probe(restored).restoredMarker);
                assertNull(restored.mainView().getUrl());
                BootResultFixtureActivity.latest.finishSyntheticResult();
            });
            await("actual AndroidX/Capacitor callback lost", () -> BootResultProbePlugin.activityResults.get() == 1);
            ui(() -> {
                assertNotNull(BootResultProbePlugin.activityCall);
                assertEquals(PluginCall.CALLBACK_ID_DANGLING, BootResultProbePlugin.activityCall.getCallbackId());
                assertEquals("original-options", BootResultProbePlugin.activityCall.getString("marker"));
                assertTrue(BootResultProbePlugin.gateClosedAtActivityResult);
                Plugin app = restored.getBridge().getPlugin("App").getInstance();
                CapturingListener listener = consume(app, "appRestoredResult");
                assertEquals(1, listener.received.size());
                assertEquals("BootResultProbe", listener.received.get(0).optString("pluginId"));
                assertEquals("preserved-result", listener.received.get(0).optJSONObject("data").optString("value"));
                assertEquals(0, consume(app, "appRestoredResult").received.size());
            });
            Thread.sleep(300);
            assertEquals("result delivered twice", 1, BootResultProbePlugin.activityResults.get());
        }
    }
}
