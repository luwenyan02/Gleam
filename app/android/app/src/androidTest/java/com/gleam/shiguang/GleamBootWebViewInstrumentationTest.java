package com.gleam.shiguang;

import android.os.Bundle;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Does not contact a server or create/delete any storage. Requires a real Android WebView. */
@RunWith(AndroidJUnit4.class)
public class GleamBootWebViewInstrumentationTest {
    @Test public void constructionClosedGateDropsAllNavigationAndJavascript() {
        AtomicBoolean javascriptCallback = new AtomicBoolean();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            GleamBootWebView view = new GleamBootWebView(
                InstrumentationRegistry.getInstrumentation().getTargetContext(), null);
            try {
                view.getSettings().setJavaScriptEnabled(true);
                assertFalse(view.bootState().hasInitialLoad());
                view.loadUrl("javascript:window.gleamBootBypass=true");
                view.loadUrl("https://localhost/", Collections.singletonMap("X-Synthetic-Test", "blocked"));
                view.postUrl("https://localhost/", new byte[] {1});
                view.loadData("<script>window.gleamBootBypass=true</script>", "text/html", "UTF-8");
                view.loadDataWithBaseURL("https://localhost/", "<script>window.gleamBootBypass=true</script>", "text/html", "UTF-8", null);
                view.evaluateJavascript("window.gleamBootBypass=true", value -> javascriptCallback.set(true));
                view.reload();
                view.goBack();
                view.goForward();
                view.goBackOrForward(1);
                assertNull(view.restoreState(new Bundle()));
                assertFalse(view.canGoBack());
                assertFalse(view.canGoForward());
                assertFalse(view.canGoBackOrForward(1));
                assertNull(view.getUrl());
                assertFalse(view.bootState().hasInitialLoad());
                view.loadUrl("https://localhost");
                view.loadUrl("https://localhost/");
                assertTrue(view.bootState().hasInitialLoad());
                assertNull(view.getUrl());
                assertFalse(javascriptCallback.get());
            } finally { view.destroy(); }
        });
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        assertFalse(javascriptCallback.get());
    }
}
