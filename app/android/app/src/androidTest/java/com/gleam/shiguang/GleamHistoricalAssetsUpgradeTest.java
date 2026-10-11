package com.gleam.shiguang;

import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.webkit.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import static org.junit.Assert.*;

/**
 * Exact historical PUBLIC ASSET swap in a single current debug APK, on a disposable emulator.
 * Not an APK install/replace test, signing test, process-death test, or real-ledger migration.
 * Package test inputs into androidTest/assets/upgrade-fixtures, never the application assets.
 */
@RunWith(AndroidJUnit4.class)
@SdkSuppress(minSdkVersion = 26)
public class GleamHistoricalAssetsUpgradeTest {
    private static final String ROOT = "https://localhost/";
    private static final String OLD_MODULE = "/assets/index-Cp2pgZ4U.js";
    private static final String ZIP_SHA = "c6411b17b13e9cd495662f88a607dfbd848c2c06d7c3713f2c5b5c96b16c996e";
    private static final String APK_SHA = "8a96117c98a6b62e5597e8e9cd6efd99a9d413c55f630fd0d665aef4ed063265";
    private static final String KEEP = "historical-fixture-keep";
    private static final String DB = "historical-assets-synthetic";
    private static final String MODULE_QUERY = "document.querySelector('script[type=module]')?.getAttribute('src')";
    private static final String SANDBOX = "(()=>{const allowed=u=>new URL(u,location.href).origin==='https://localhost';"
        + "const f=window.fetch;window.fetch=function(u,o){if(!allowed(u instanceof Request?u.url:u))return Promise.reject(Error('fixture blocked nonlocal fetch'));return f.call(this,u,o)};"
        + "const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){if(!allowed(u))throw Error('fixture blocked nonlocal XHR');return open.call(this,m,u,...a)};"
        + "window.WebSocket=function(){throw Error('fixture disables WebSockets')};"
        + "const beacon=navigator.sendBeacon;navigator.sendBeacon=function(u,d){if(!allowed(u))return false;return beacon.call(this,u,d)};})()";

    private static void ui(Runnable action) { InstrumentationRegistry.getInstrumentation().runOnMainSync(action); }
    private static byte[] bytes(InputStream input) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                assertTrue("fixture exceeds bounded input size", out.size() + count <= 4 * 1024 * 1024);
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }
    private static String hash(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
    private static Map<String, byte[]> historicalAssets() throws Exception {
        Context tests = InstrumentationRegistry.getInstrumentation().getContext();
        JSONObject manifest = new JSONObject(new String(bytes(tests.getAssets().open("upgrade-fixtures/manifest.json")), StandardCharsets.UTF_8));
        assertEquals(1, manifest.getInt("format"));
        assertEquals("assets/public/", manifest.getString("source_prefix"));
        JSONObject version = manifest.getJSONObject("versions").getJSONObject("1.10.5");
        assertEquals("Gleam-v1.10.5-private-ui.apk", version.getString("source_apk"));
        assertEquals(APK_SHA, version.getString("source_apk_sha256"));
        assertEquals("gleam-1.10.5-public.zip", version.getString("fixture"));
        assertEquals(ZIP_SHA, version.getString("fixture_sha256"));
        assertEquals(OLD_MODULE, version.getString("module_url"));
        byte[] archive = bytes(tests.getAssets().open("upgrade-fixtures/gleam-1.10.5-public.zip"));
        assertEquals("historical fixture ZIP changed", ZIP_SHA, hash(archive));
        JSONObject expected = version.getJSONObject("assets");
        Map<String, byte[]> assets = new HashMap<>();
        // Entries stay in memory. Explicit names and hash equality prevent traversal/aliases.
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(archive))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName();
                assertFalse(entry.isDirectory());
                assertTrue("unexpected fixture entry: " + name, expected.has(name));
                assertFalse(name.contains("..") || name.contains("\\") || name.startsWith("/"));
                assertFalse("duplicate fixture entry", assets.containsKey(name));
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int count;
                while ((count = zip.read(buffer)) != -1) {
                    assertTrue(out.size() + count <= 2 * 1024 * 1024);
                    out.write(buffer, 0, count);
                }
                byte[] value = out.toByteArray();
                JSONObject facts = expected.getJSONObject(name);
                assertEquals(facts.getInt("bytes"), value.length);
                assertEquals("asset hash changed: " + name, facts.getString("sha256"), hash(value));
                assets.put(name, value);
            }
        }
        assertEquals(28, assets.size());
        assertEquals(expected.length(), assets.size());
        for (Iterator<String> names = expected.keys(); names.hasNext();) assertTrue(assets.containsKey(names.next()));
        assertEquals("1.10.5", new JSONObject(new String(assets.get("build-info.json"), StandardCharsets.UTF_8)).getString("version"));
        assertEquals(OLD_MODULE, module(new String(assets.get("index.html"), StandardCharsets.UTF_8)));
        return assets;
    }
    private static String module(String html) {
        Matcher matcher = Pattern.compile("<script\\b[^>]*\\btype=\"module\"[^>]*\\bsrc=\"([^\"]+)\"").matcher(html);
        assertTrue("no entry module in packaged index", matcher.find());
        String module = matcher.group(1);
        assertFalse("multiple entry modules", matcher.find());
        return module;
    }
    private static boolean local(Uri uri) { return "https".equals(uri.getScheme()) && "localhost".equals(uri.getHost()) && uri.getPort() == -1 && uri.getUserInfo() == null; }
    private static WebResourceResponse denied() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    private static WebResourceResponse oldResponse(WebResourceRequest request, Map<String, byte[]> assets, AtomicInteger outside, AtomicInteger modules) {
        if (!local(request.getUrl())) { outside.incrementAndGet(); return denied(); }
        String path = request.getUrl().getEncodedPath();
        String name = path == null || path.isEmpty() || "/".equals(path) ? "index.html" : path.substring(1);
        byte[] value = assets.get(name);
        if (value == null) return denied();
        if (OLD_MODULE.substring(1).equals(name)) modules.incrementAndGet();
        String mime = name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".png") ? "image/png" : name.endsWith(".json") || name.endsWith(".webmanifest") ? "application/json" : "text/html";
        return new WebResourceResponse(mime, "UTF-8", 200, "OK", Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(value));
    }
    private static String js(WebView view, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        ui(() -> view.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        assertTrue("historical fixture JS query timed out", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }
    private static void awaitJs(WebView view, String expression, String expected) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        String actual;
        do { actual = js(view, expression); if (expected.equals(actual)) return; Thread.sleep(50); } while (System.nanoTime() < end);
        assertEquals(expression, expected, actual);
    }
    private static void sandbox(WebView view) {
        assertTrue("requires document-start injection for offline fixture isolation", WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT));
        WebViewCompat.addDocumentStartJavaScript(view, SANDBOX, Collections.singleton("https://localhost"));
    }
    private static void observe(WebView view, AtomicReference<String> facts, AtomicInteger outside, AtomicInteger oldRequests) {
        WebViewClient delegate = view.getWebViewClient();
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return delegate.shouldOverrideUrlLoading(v, r); }
            @SuppressWarnings("deprecation") @Override public boolean shouldOverrideUrlLoading(WebView v, String u) { return delegate.shouldOverrideUrlLoading(v, u); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                if (!local(r.getUrl())) outside.incrementAndGet();
                if (OLD_MODULE.equals(r.getUrl().getEncodedPath())) oldRequests.incrementAndGet();
                return delegate.shouldInterceptRequest(v, r);
            }
            @Override public void onPageStarted(WebView v, String u, Bitmap b) { delegate.onPageStarted(v, u, b); }
            @Override public void onPageCommitVisible(WebView v, String u) { delegate.onPageCommitVisible(v, u); }
            @Override public void onPageFinished(WebView v, String u) {
                delegate.onPageFinished(v, u);
                v.evaluateJavascript("[" + MODULE_QUERY + ",navigator.serviceWorker.controller?.scriptURL,document.documentElement.getAttribute('data-theme'),document.getElementById('app')?.childElementCount,typeof window.androidBridge,typeof window.Capacitor]", facts::set);
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) { delegate.onReceivedError(v, r, e); }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse e) { delegate.onReceivedHttpError(v, r, e); }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) { delegate.onReceivedSslError(v, h, e); }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) { return delegate.onRenderProcessGone(v, d); }
        });
    }

    @Test public void exact1105WorkerServesInertCachedShellBeforeCurrentNativeBoot() throws Exception {
        assertEquals("requires explicit disposable-emulator fixture opt-in", "true", InstrumentationRegistry.getArguments().getString("gleamEphemeralFixture"));
        assertTrue("never run this asset-state fixture on a user's phone", Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish"));
        Map<String, byte[]> old = historicalAssets();
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String currentModule = module(new String(bytes(target.getAssets().open("public/index.html")), StandardCharsets.UTF_8));
        assertNotEquals("current shell must differ from historical shell", OLD_MODULE, currentModule);
        String currentVersion = new JSONObject(new String(bytes(target.getAssets().open("public/build-info.json")), StandardCharsets.UTF_8)).getString("version");
        assertEquals(target.getPackageManager().getPackageInfo(target.getPackageName(), 0).versionName, currentVersion);
        JSONObject config = new JSONObject(new String(bytes(target.getAssets().open("capacitor.config.json")), StandardCharsets.UTF_8));
        assertFalse("Bridge must not overwrite the closed processwide interceptor", config.getJSONObject("android").getBoolean("resolveServiceWorkerRequests"));
        AtomicInteger outside = new AtomicInteger(), baselineModules = new AtomicInteger(), seedDocuments = new AtomicInteger();
        AtomicInteger quarantineOldRequests = new AtomicInteger(), currentOldRequests = new AtomicInteger();
        AtomicReference<WebView> seedRef = new AtomicReference<>();
        try {
            ui(() -> {
                ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest r) { return oldResponse(r, old, outside, baselineModules); }
                });
                WebView seed = new WebView(target);
                seedRef.set(seed);
                seed.getSettings().setJavaScriptEnabled(true);
                seed.getSettings().setDomStorageEnabled(true);
                seed.getSettings().setAllowFileAccess(false);
                seed.getSettings().setAllowContentAccess(false);
                sandbox(seed);
                seed.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return oldResponse(r, old, outside, baselineModules); }
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return !local(r.getUrl()); }
                    @Override public void onPageFinished(WebView v, String url) { if (ROOT.equals(url)) seedDocuments.incrementAndGet(); }
                });
                seed.loadUrl(ROOT);
            });
            WebView seed = seedRef.get();
            try {
                awaitJs(seed, "Boolean(document.getElementById('fab'))", "true");
                assertEquals(OLD_MODULE, new org.json.JSONTokener(js(seed, MODULE_QUERY)).nextValue());
                awaitJs(seed, "navigator.serviceWorker.controller?.scriptURL", "\"https://localhost/sw.js\"");
                assertTrue("exact old entry module must really have been served", baselineModules.get() > 0);
                js(seed, "(()=>{localStorage.setItem('gleam-theme','dark');localStorage.setItem('" + KEEP + "','synthetic-ledger');window.fixtureSeed=false;const q=indexedDB.open('" + DB + "',1);q.onupgradeneeded=()=>q.result.createObjectStore('sentinel');q.onsuccess=()=>{const d=q.result;const t=d.transaction('sentinel','readwrite');t.objectStore('sentinel').put('synthetic-ledger-idb','keep');t.oncomplete=()=>{d.close();window.fixtureSeed=true}};})()");
                awaitJs(seed, "window.fixtureSeed", "true");
                // The historical module mirrors its actual theme.mode setting back into
                // localStorage. Seed that fictional preference too, so mounted baseline
                // dark-theme evidence cannot depend on the emulator's system theme.
                js(seed, "(()=>{window.fixtureTheme=false;const q=indexedDB.open('GleamDB');q.onupgradeneeded=()=>{q.transaction.abort();window.fixtureTheme='failed'};q.onerror=()=>window.fixtureTheme='failed';q.onsuccess=()=>{const d=q.result;const t=d.transaction('settings','readwrite');t.objectStore('settings').put({key:'theme.mode',value:'dark',updatedAt:Date.now()});t.oncomplete=()=>{d.close();localStorage.setItem('gleam-theme','dark');window.fixtureTheme=true};t.onerror=()=>{d.close();window.fixtureTheme='failed'}};})()");
                awaitJs(seed, "window.fixtureTheme", "true");
                int beforeReload = seedDocuments.get();
                ui(seed::reload);
                GleamNativeBootLifecycleTest.await("controlled historical navigation did not finish", () -> seedDocuments.get() > beforeReload);
                awaitJs(seed, "Boolean(document.getElementById('fab')) && document.documentElement.getAttribute('data-theme')==='dark'", "true");
                assertEquals(OLD_MODULE, new org.json.JSONTokener(js(seed, MODULE_QUERY)).nextValue());
                // Workbox's exact cached original index is checked after the controlled reload.
                js(seed, "window.fixtureCacheHash=null;caches.match('https://localhost/index.html',{ignoreSearch:true}).then(r=>{if(!r)throw Error('no cached index');return r.arrayBuffer()}).then(b=>crypto.subtle.digest('SHA-256',b)).then(b=>window.fixtureCacheHash=Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')).catch(()=>window.fixtureCacheHash='failed')");
                awaitJs(seed, "window.fixtureCacheHash", "\"41e734024cf167e0bb190ff35c6bf14748296133aeee497388ba2dbb2edf2078\"");
            } finally {
                ui(() -> { try { seed.stopLoading(); } finally { seed.destroy(); } });
                seedRef.set(null);
            }

            AtomicReference<String> quarantineFacts = new AtomicReference<>();
            BootLifecycleFixtureActivity.holdCleanup = false;
            BootLifecycleFixtureActivity.quarantineObserver = quarantine -> {
                observe(quarantine, quarantineFacts, outside, quarantineOldRequests);
                WebView main = BootLifecycleFixtureActivity.latest.mainView();
                sandbox(main);
                // Preserve the debug fixture's complete network fence and actual Bridge callbacks.
                observe(main, new AtomicReference<>(), outside, currentOldRequests);
            };
            try (ActivityScenario<BootLifecycleFixtureActivity> scenario = ActivityScenario.launch(
                new android.content.Intent(target, BootLifecycleFixtureActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))) {
                GleamNativeBootLifecycleTest.await("historical cached root cleanup did not open current app", () -> BootLifecycleFixtureActivity.latest.mainView().bootState().isOpen());
                GleamNativeBootLifecycleTest.await("exact cached quarantine document not observed", () -> quarantineFacts.get() != null);
                assertEquals("cached old HTML must arrive via its worker, remain unmounted, and expose no Bridge",
                    "[\"" + OLD_MODULE + "\",\"https://localhost/sw.js\",null,0,\"undefined\",\"undefined\"]", quarantineFacts.get());
                WebView current = BootLifecycleFixtureActivity.latest.mainView();
                awaitJs(current, "Boolean(document.getElementById('fab'))", "true");
                assertEquals(currentModule, new org.json.JSONTokener(js(current, MODULE_QUERY)).nextValue());
                assertEquals("null", js(current, "navigator.serviceWorker.controller"));
                assertEquals("\"synthetic-ledger\"", js(current, "localStorage.getItem('" + KEEP + "')"));
                js(current, "(()=>{window.fixtureRead=null;const q=indexedDB.open('" + DB + "',1);q.onsuccess=()=>{const d=q.result;const t=d.transaction('sentinel');const r=t.objectStore('sentinel').get('keep');r.onsuccess=()=>{window.fixtureRead=r.result;d.close()}};})()");
                awaitJs(current, "window.fixtureRead", "\"synthetic-ledger-idb\"");
                js(current, "(()=>{window.fixtureThemeRead=null;const q=indexedDB.open('GleamDB');q.onsuccess=()=>{const d=q.result;const t=d.transaction('settings');const r=t.objectStore('settings').get('theme.mode');r.onsuccess=()=>{window.fixtureThemeRead=r.result?.value;d.close()}};})()");
                awaitJs(current, "window.fixtureThemeRead", "\"dark\"");
                assertEquals("\"dark\"", js(current, "localStorage.getItem('gleam-theme')"));
                js(current, "window.fixtureRoots=null;navigator.serviceWorker.getRegistrations().then(rs=>window.fixtureRoots=rs.filter(r=>r.scope==='https://localhost/').length)");
                awaitJs(current, "window.fixtureRoots", "0");
                assertEquals("offline fixture must never request outside localhost", 0, outside.get());
                assertEquals("current shell must not request the historical entry module", 0, currentOldRequests.get());
                android.util.Log.i("GleamHistoricalAssets", "Exact 1.10.5 public assets -> " + currentVersion + "; cached old HTML inert witnesses passed; old-module quarantine requests=" + quarantineOldRequests.get() + "; asset swap only, no APK replacement");
            }
        } finally {
            try {
                WebView abandoned = seedRef.getAndSet(null);
                if (abandoned != null) ui(() -> { try { abandoned.stopLoading(); } finally { abandoned.destroy(); } });
            } finally {
                BootLifecycleFixtureActivity.quarantineObserver = null;
                BootLifecycleFixtureActivity.holdCleanup = false;
                // Also cover seed setup/baseline failures before an ActivityScenario exists.
                ui(GleamBootGuard::installClosedInterceptor);
            }
        }
    }
}
