package com.gleam.shiguang;

import android.content.Intent;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.util.Base64;
import android.webkit.*;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import static com.gleam.shiguang.InstallReplaceFixtureSupport.*;
import static org.junit.Assert.*;

/** Stage 2 only; must follow adb install -r with no uninstall, clear-data or reseeding. */
@RunWith(AndroidJUnit4.class)
@SdkSuppress(minSdkVersion = 26)
public class GleamInstallReplaceVerifyTest {
    private static void observe(WebView quarantine, AtomicReference<String> facts) {
        WebViewClient delegate = quarantine.getWebViewClient();
        quarantine.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return delegate.shouldOverrideUrlLoading(v, r); }
            @SuppressWarnings("deprecation") @Override public boolean shouldOverrideUrlLoading(WebView v, String u) { return delegate.shouldOverrideUrlLoading(v, u); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return delegate.shouldInterceptRequest(v, r); }
            @Override public void onPageStarted(WebView v, String u, Bitmap b) { delegate.onPageStarted(v, u, b); }
            @Override public void onPageFinished(WebView v, String u) {
                delegate.onPageFinished(v, u);
                v.evaluateJavascript("[" + MODULE_QUERY + ",navigator.serviceWorker.controller?.scriptURL,document.documentElement.getAttribute('data-theme'),document.getElementById('app')?.childElementCount,typeof window.androidBridge,typeof window.Capacitor]", facts::set);
            }
            @Override public void onPageCommitVisible(WebView v, String u) { delegate.onPageCommitVisible(v, u); }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) { delegate.onReceivedError(v, r, e); }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse e) { delegate.onReceivedHttpError(v, r, e); }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler h, SslError e) { delegate.onReceivedSslError(v, h, e); }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) { return delegate.onRenderProcessGone(v, d); }
        });
    }
    @SuppressWarnings("deprecation")
    @Test public void replacedPackagePreservesOldProfileAndBootsCurrentShell() throws Exception {
        assertDisposableEmulator();
        assertTrue("old APK stage was not completed; verification never seeds markers", prefs().getBoolean("seed_complete", false));
        assertEquals("1.10.5", prefs().getString("old_version", null));
        assertEquals(11005, prefs().getInt("old_code", -1));
        assertEquals(INDEX_SHA, prefs().getString("packaged_index_sha256", null));
        String servedCacheHash = prefs().getString("cached_index_sha256", "");
        assertTrue("missing actual Bridge-served cached HTML digest", servedCacheHash.matches("[0-9a-f]{64}"));
        assertEquals("the two self-built harness APKs must retain one debug signer", prefs().getString("signer_sha256", null), installedSigner());
        android.content.pm.PackageInfo installed = target().getPackageManager().getPackageInfo(target().getPackageName(), 0);
        assertTrue("package replacement must increase the installed version code", installed.versionCode > 11005);
        String currentVersion = new JSONObject(new String(asset(target(), "public/build-info.json"), StandardCharsets.UTF_8)).getString("version");
        assertEquals(installed.versionName, currentVersion);
        assertNotEquals("1.10.5", currentVersion);
        String currentIndex = new String(asset(target(), "public/index.html"), StandardCharsets.UTF_8);
        java.util.regex.Matcher module = java.util.regex.Pattern.compile("<script\\b[^>]*\\btype=\"module\"[^>]*\\bsrc=\"([^\"]+)\"").matcher(currentIndex);
        assertTrue(module.find());
        String currentModule = module.group(1);
        assertNotEquals(OLD_MODULE, currentModule);
        assertFalse(module.find());
        AtomicReference<String> facts = new AtomicReference<>();
        BootLifecycleFixtureActivity.holdCleanup = false;
        BootLifecycleFixtureActivity.quarantineObserver = q -> observe(q, facts);
        try (ActivityScenario<BootLifecycleFixtureActivity> scenario = ActivityScenario.launch(
            new Intent(target(), BootLifecycleFixtureActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))) {
            GleamNativeBootLifecycleTest.await("replacement candidate did not open main gate", () -> BootLifecycleFixtureActivity.latest.mainView().bootState().isOpen());
            GleamNativeBootLifecycleTest.await("retained historical cached document not observed", () -> facts.get() != null);
            assertJsonEquals("exact cached old shell must stay unmounted and unbridged",
                "[\"" + OLD_MODULE + "\",\"https://localhost/sw.js\",null,0,\"undefined\",\"undefined\"]", facts.get());
            WebView current = BootLifecycleFixtureActivity.latest.mainView();
            awaitJs(current, "Boolean(document.getElementById('fab')) && document.documentElement.getAttribute('data-theme')==='dark'", "true");
            assertJsString(current, MODULE_QUERY, currentModule);
            assertEquals("null", js(current, "navigator.serviceWorker.controller"));
            assertEquals("\"synthetic-apk-ledger\"", js(current, "localStorage.getItem('" + KEEP + "')"));
            run(current, "window.apkRead=null;const q=indexedDB.open('" + DB + "',1);q.onupgradeneeded=()=>{q.transaction.abort();window.apkRead='missing'};q.onsuccess=()=>{const d=q.result;const t=d.transaction('sentinel');const r=t.objectStore('sentinel').get('keep');r.onsuccess=()=>{window.apkRead=r.result;d.close()}};");
            awaitJs(current, "window.apkRead", "\"synthetic-apk-idb\"");
            run(current, "window.apkThemeRead=null;const q=indexedDB.open('GleamDB');q.onupgradeneeded=()=>{q.transaction.abort();window.apkThemeRead='missing'};q.onsuccess=()=>{const d=q.result;const t=d.transaction('settings');const r=t.objectStore('settings').get('theme.mode');r.onsuccess=()=>{window.apkThemeRead=r.result?.value;d.close()}};");
            awaitJs(current, "window.apkThemeRead", "\"dark\"");
            assertJsString(current, "localStorage.getItem('gleam-theme')", "dark");
            run(current, "window.apkRoots=null;navigator.serviceWorker.getRegistrations().then(rs=>window.apkRoots=rs.filter(r=>r.scope==='https://localhost/').length);");
            awaitJs(current, "window.apkRoots", "0");
            run(current, "window.apkRetainedCacheHash=null;caches.match('https://localhost/index.html',{ignoreSearch:true}).then(r=>{if(!r)throw Error('missing old cache');return r.arrayBuffer()}).then(b=>crypto.subtle.digest('SHA-256',b)).then(b=>window.apkRetainedCacheHash=Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')).catch(()=>window.apkRetainedCacheHash='failed');");
            awaitJs(current, "window.apkRetainedCacheHash", JSONObject.quote(servedCacheHash));
            java.security.KeyStore keys = java.security.KeyStore.getInstance("AndroidKeyStore");
            keys.load(null);
            assertTrue("replacement lost the synthetic native key", keys.containsAlias(ALIAS));
            javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(javax.crypto.Cipher.DECRYPT_MODE, keys.getKey(ALIAS, null), new javax.crypto.spec.GCMParameterSpec(128,
                Base64.decode(prefs().getString("iv", ""), Base64.NO_WRAP)));
            assertEquals("synthetic-apk-keystore", new String(cipher.doFinal(
                Base64.decode(prefs().getString("ciphertext", ""), Base64.NO_WRAP)), StandardCharsets.UTF_8));
            android.util.Log.i("GleamInstallReplace", "1.10.5/11005 debug old-web/current-native harness -> " + currentVersion + "/" + installed.versionCode
                + "; package replacement, SharedPreferences/LS/IDB/Keystore retained; original native/signature compatibility NOT tested");
        } finally {
            BootLifecycleFixtureActivity.quarantineObserver = null;
            BootLifecycleFixtureActivity.holdCleanup = false;
            ui(GleamBootGuard::installClosedInterceptor);
        }
    }
}
