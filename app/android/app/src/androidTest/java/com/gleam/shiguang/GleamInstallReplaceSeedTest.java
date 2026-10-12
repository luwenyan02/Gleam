package com.gleam.shiguang;

import android.content.Intent;
import android.util.Base64;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.SdkSuppress;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.nio.charset.StandardCharsets;
import static com.gleam.shiguang.InstallReplaceFixtureSupport.*;
import static org.junit.Assert.*;

/** Stage 1 only: self-built old-web/current-native DEBUG harness, not the historical native APK. */
@RunWith(AndroidJUnit4.class)
@SdkSuppress(minSdkVersion = 26)
public class GleamInstallReplaceSeedTest {
    @SuppressWarnings("deprecation")
    @Test public void seedVerifiedOldInstalledPackageForReplacement() throws Exception {
        assertDisposableEmulator();
        android.content.pm.PackageInfo installed = target().getPackageManager().getPackageInfo(target().getPackageName(), 0);
        assertEquals("1.10.5", installed.versionName);
        assertEquals(11005, installed.versionCode);
        assertFalse("requires a fresh package profile, never overwrite an earlier seed", prefs().getBoolean("seed_complete", false));
        verifyPackagedOldAssets();
        try (ActivityScenario<BootInstallReplaceBaselineActivity> scenario = ActivityScenario.launch(
            new Intent(target(), BootInstallReplaceBaselineActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))) {
            WebView view = BootInstallReplaceBaselineActivity.latest.getBridge().getWebView();
            awaitJs(view, "Boolean(document.getElementById('fab'))", "true");
            assertJsString(view, MODULE_QUERY, OLD_MODULE);
            awaitJs(view, "navigator.serviceWorker.controller?.scriptURL", "\"https://localhost/sw.js\"");
            run(view, "localStorage.setItem('" + KEEP + "','synthetic-apk-ledger');window.apkSeed=false;const q=indexedDB.open('" + DB + "',1);q.onupgradeneeded=()=>q.result.createObjectStore('sentinel');q.onsuccess=()=>{const d=q.result;const t=d.transaction('sentinel','readwrite');t.objectStore('sentinel').put('synthetic-apk-idb','keep');t.oncomplete=()=>{d.close();window.apkSeed=true}};");
            awaitJs(view, "window.apkSeed", "true");
            run(view, "window.apkTheme=false;const q=indexedDB.open('GleamDB');q.onupgradeneeded=()=>{q.transaction.abort();window.apkTheme='failed'};q.onsuccess=()=>{const d=q.result;const t=d.transaction('settings','readwrite');t.objectStore('settings').put({key:'theme.mode',value:'dark',updatedAt:Date.now()});t.oncomplete=()=>{d.close();localStorage.setItem('gleam-theme','dark');window.apkTheme=true}};");
            awaitJs(view, "window.apkTheme", "true");
            ui(view::reload);
            awaitJs(view, "typeof window.apkTheme==='undefined' && Boolean(document.getElementById('fab')) && document.documentElement.getAttribute('data-theme')==='dark'", "true");
            awaitJs(view, "navigator.serviceWorker.controller?.scriptURL", "\"https://localhost/sw.js\"");
            assertJsString(view, MODULE_QUERY, OLD_MODULE);
            run(view, "window.apkCacheHash=null;caches.match('https://localhost/index.html',{ignoreSearch:true}).then(r=>{if(!r)throw Error('missing index');return r.arrayBuffer()}).then(b=>crypto.subtle.digest('SHA-256',b)).then(b=>window.apkCacheHash=Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')).catch(()=>window.apkCacheHash='failed');");
            awaitJs(view, "typeof window.apkCacheHash==='string' && /^[0-9a-f]{64}$/.test(window.apkCacheHash)", "true");
            String servedCacheHash = new org.json.JSONArray("[" + js(view, "window.apkCacheHash") + "]").getString(0);
            // Keep actual Bridge runtime behavior: cached HTML may be injected or raw when
            // document-start injection is supported. Its actual digest is recorded separately.
            run(view, "window.apkCachedModule=null;caches.match('https://localhost/index.html',{ignoreSearch:true}).then(r=>r.text()).then(t=>window.apkCachedModule=t.includes('" + OLD_MODULE + "')).catch(()=>window.apkCachedModule=false);");
            awaitJs(view, "window.apkCachedModule", "true");

            // Synthetic native encryption key and preferences must survive package replacement.
            javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance("AES", "AndroidKeyStore");
            generator.init(new android.security.keystore.KeyGenParameterSpec.Builder(ALIAS,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT | android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes("GCM").setEncryptionPaddings("NoPadding").build());
            javax.crypto.SecretKey key = generator.generateKey();
            javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, key);
            byte[] encrypted = cipher.doFinal("synthetic-apk-keystore".getBytes(StandardCharsets.UTF_8));
            assertTrue(prefs().edit().putString("old_version", installed.versionName).putInt("old_code", installed.versionCode)
                .putString("signer_sha256", installedSigner()).putString("cached_index_sha256", servedCacheHash)
                .putString("packaged_index_sha256", INDEX_SHA)
                .putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .putBoolean("seed_complete", true).commit());
        } finally { ui(GleamBootGuard::installClosedInterceptor); }
    }
}
