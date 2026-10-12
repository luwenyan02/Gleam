package com.gleam.shiguang;

import android.graphics.Bitmap;
import android.net.http.SslError;
import android.webkit.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Production MainActivity + real WebView + synthetic old owned worker, on ephemeral emulators only. */
@androidx.test.filters.SdkSuppress(minSdkVersion = 26)
@RunWith(AndroidJUnit4.class)
public class GleamNativeBootUpgradeIntegrationTest {
    private static final String ROOT = "https://localhost/";
    private static final String COUNTS = "['boot-int-inline','boot-int-module','boot-int-external','boot-int-load','boot-int-error','boot-int-timer'].map(k=>Number(localStorage.getItem(k)||0))";
    private static final String OLD = "<!doctype html><meta name=boot-integration-document content=old><body onload=\"localStorage.setItem('boot-int-load',1)\"><img src='/boot-int-bad.png' onerror=\"localStorage.setItem('boot-int-error',1)\"><script>localStorage.setItem('boot-int-inline',1);if(window.androidBridge)androidBridge.postMessage('{}');setTimeout(()=>localStorage.setItem('boot-int-timer',1),0)</script><script src='/boot-int-old.js'></script><script type=module>localStorage.setItem('boot-int-module',1)</script>";
    private static final String SW = "self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open('boot-integration-cache').then(c=>c.put('/',new Response(" + org.json.JSONObject.quote(OLD) + ",{headers:{'Content-Type':'text/html'}}))));});self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(caches.open('boot-integration-cache').then(c=>c.match('/')));});";
    private static WebResourceResponse fixtureResponse(WebResourceRequest request) {
        String path = request.getUrl().getPath();
        String body = "/sw.js".equals(path) ? SW : "/boot-int-old.js".equals(path)
            ? "localStorage.setItem('boot-int-external',1)" : "<!doctype html><title>synthetic-seed</title>";
        return new WebResourceResponse(path.endsWith(".js") ? "application/javascript" : "text/html", "UTF-8",
            new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }
    private static String js(WebView view, String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        GleamNativeBootLifecycleTest.ui(() -> view.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        assertTrue("JavaScript query timed out", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }
    private static void awaitJs(WebView view, String expression, String expected) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
        String result;
        do { result = js(view, expression); if (expected.equals(result)) return; Thread.sleep(50); } while (System.nanoTime() < end);
        assertEquals(expression, expected, result);
    }
    /** Observation delegates every callback overridden by the production guard unchanged. */
    private static void observe(WebView quarantine, AtomicReference<String> observed) {
        assertFalse("quarantine must start with scripting disabled", quarantine.getSettings().getJavaScriptEnabled());
        WebViewClient delegate = quarantine.getWebViewClient();
        quarantine.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return delegate.shouldOverrideUrlLoading(v, r); }
            @SuppressWarnings("deprecation") @Override public boolean shouldOverrideUrlLoading(WebView v, String u) { return delegate.shouldOverrideUrlLoading(v, u); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return delegate.shouldInterceptRequest(v, r); }
            @Override public void onPageStarted(WebView v, String u, Bitmap b) { delegate.onPageStarted(v, u, b); }
            @Override public void onPageFinished(WebView v, String u) {
                delegate.onPageFinished(v, u);
                // Production enabled JS for its allow-listed cleanup only. Read-only extra
                // observation is queued before the guard polls/destroys this same client.
                v.evaluateJavascript(
                    "[document.querySelector('meta[name=boot-integration-document]')?.content,typeof window.androidBridge,typeof window.Capacitor," + COUNTS + "]",
                    observed::set);
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) { delegate.onReceivedError(v, r, e); }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse e) { delegate.onReceivedHttpError(v, r, e); }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) { delegate.onReceivedSslError(v, h, e); }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) { return delegate.onRenderProcessGone(v, d); }
        });
    }
    @Test public void candidateGateRemovesOwnedWorkerWithoutRunningOldApplicationOrExposingBridge() throws Exception {
        java.security.KeyStore keys = java.security.KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
        javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance("AES", "AndroidKeyStore");
        generator.init(new android.security.keystore.KeyGenParameterSpec.Builder("gleam-boot-integration-synthetic",
            android.security.keystore.KeyProperties.PURPOSE_ENCRYPT | android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes("GCM").setEncryptionPaddings("NoPadding").build());
        javax.crypto.SecretKey sentinelKey = generator.generateKey();
        javax.crypto.Cipher seal = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        seal.init(javax.crypto.Cipher.ENCRYPT_MODE, sentinelKey);
        byte[] encrypted = seal.doFinal("synthetic-keystore-sentinel".getBytes(StandardCharsets.UTF_8));
        byte[] iv = seal.getIV();
        AtomicReference<WebView> seedRef = new AtomicReference<>();
        AtomicReference<String> quarantineObserved = new AtomicReference<>();
        GleamNativeBootLifecycleTest.ui(() -> {
            ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest r) { return fixtureResponse(r); }
            });
            WebView seed = new WebView(GleamNativeBootLifecycleTest.instrumentation().getTargetContext());
            seed.getSettings().setJavaScriptEnabled(true);
            seed.getSettings().setDomStorageEnabled(true);
            seed.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return fixtureResponse(r); }
            });
            seedRef.set(seed);
            seed.loadUrl(ROOT);
        });
        WebView seed = seedRef.get();
        try {
            awaitJs(seed, "document.title", "\"synthetic-seed\"");
            js(seed, "['boot-int-inline','boot-int-module','boot-int-external','boot-int-load','boot-int-error','boot-int-timer'].forEach(k=>localStorage.setItem(k,'0'));localStorage.setItem('boot-int-preserved','synthetic-ledger');window.bootIntReady=false;navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(r=>window.bootIntReady=!!r.active).catch(()=>window.bootIntReady='failed')");
            js(seed, "window.bootIntDb=false;const q=indexedDB.open('boot-integration-synthetic',1);q.onupgradeneeded=()=>q.result.createObjectStore('sentinel');q.onsuccess=()=>{const db=q.result;const tx=db.transaction('sentinel','readwrite');tx.objectStore('sentinel').put('synthetic-ledger-idb','keep');tx.oncomplete=()=>{db.close();window.bootIntDb=true}};");
            awaitJs(seed, "window.bootIntDb", "true");
            awaitJs(seed, "window.bootIntReady", "true");
            awaitJs(seed, "Boolean(navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL==='https://localhost/sw.js')", "true");
        } finally { GleamNativeBootLifecycleTest.ui(() -> { seed.stopLoading(); seed.destroy(); }); }
        BootLifecycleFixtureActivity.holdCleanup = false;
        BootLifecycleFixtureActivity.quarantineObserver = q -> observe(q, quarantineObserved);
        try (ActivityScenario<BootLifecycleFixtureActivity> scenario = ActivityScenario.launch(GleamNativeBootLifecycleTest.intent(BootLifecycleFixtureActivity.class))) {
            GleamNativeBootLifecycleTest.await("candidate gate did not open", () -> BootLifecycleFixtureActivity.latest.mainView().bootState().isOpen());
            GleamNativeBootLifecycleTest.await("quarantine observation not delivered", () -> quarantineObserved.get() != null);
            assertEquals("[\"old\",\"undefined\",\"undefined\",[0,0,0,0,0,0]]", quarantineObserved.get());
            WebView current = BootLifecycleFixtureActivity.latest.mainView();
            awaitJs(current, "document.readyState", "\"complete\"");
            assertEquals("null", js(current, "document.querySelector('meta[name=boot-integration-document]')"));
            assertEquals("[0,0,0,0,0,0]", js(current, COUNTS));
            assertEquals("\"synthetic-ledger\"", js(current, "localStorage.getItem('boot-int-preserved')"));
            js(current, "window.bootIntRoots=null;navigator.serviceWorker.getRegistrations().then(rs=>window.bootIntRoots=rs.filter(r=>r.scope==='https://localhost/').length)");
            awaitJs(current, "window.bootIntRoots", "0");
            assertEquals("null", js(current, "navigator.serviceWorker.controller"));
            js(current, "window.bootIntDbRead=null;const q=indexedDB.open('boot-integration-synthetic',1);q.onsuccess=()=>{const db=q.result;const tx=db.transaction('sentinel');const read=tx.objectStore('sentinel').get('keep');read.onsuccess=()=>{window.bootIntDbRead=read.result;db.close()}};");
            awaitJs(current, "window.bootIntDbRead", "\"synthetic-ledger-idb\"");
            javax.crypto.Cipher unseal = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            unseal.init(javax.crypto.Cipher.DECRYPT_MODE, keys.getKey("gleam-boot-integration-synthetic", null),
                new javax.crypto.spec.GCMParameterSpec(128, iv));
            assertEquals("synthetic-keystore-sentinel", new String(unseal.doFinal(encrypted), StandardCharsets.UTF_8));
        } finally { BootLifecycleFixtureActivity.quarantineObserver = null; }
    }
}
