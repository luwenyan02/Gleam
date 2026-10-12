package com.gleam.shiguang;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Shared read/query helpers; no fixture state is silently regenerated during verification. */
final class InstallReplaceFixtureSupport {
    static final String ROOT = "https://localhost/";
    static final String OLD_MODULE = "/assets/index-Cp2pgZ4U.js";
    static final String KEEP = "install-replace-synthetic-keep";
    static final String DB = "install-replace-synthetic";
    static final String ALIAS = "gleam-install-replace-synthetic";
    static final String ZIP_SHA = "c6411b17b13e9cd495662f88a607dfbd848c2c06d7c3713f2c5b5c96b16c996e";
    static final String INDEX_SHA = "41e734024cf167e0bb190ff35c6bf14748296133aeee497388ba2dbb2edf2078";
    static final String MODULE_QUERY = "document.querySelector('script[type=module]')?.getAttribute('src')";
    static Context target() { return InstrumentationRegistry.getInstrumentation().getTargetContext(); }
    static SharedPreferences prefs() { return target().getSharedPreferences("gleam-install-replace-synthetic", Context.MODE_PRIVATE); }
    static void ui(Runnable action) { InstrumentationRegistry.getInstrumentation().runOnMainSync(action); }
    static void assertDisposableEmulator() {
        assertEquals("true", InstrumentationRegistry.getArguments().getString("gleamEphemeralFixture"));
        assertTrue("this harness must never run on a user's phone", Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish"));
        assertTrue("debug harness required", (target().getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
    }
    static byte[] asset(Context context, String name) throws Exception {
        try (InputStream stream = context.getAssets().open(name); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) != -1) { assertTrue(out.size() + count <= 4 * 1024 * 1024); out.write(buffer, 0, count); }
            return out.toByteArray();
        }
    }
    static String hash(byte[] value) throws Exception {
        StringBuilder out = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(value)) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
    @SuppressWarnings("deprecation")
    static String installedSigner() throws Exception {
        android.content.pm.PackageInfo info = target().getPackageManager().getPackageInfo(target().getPackageName(), android.content.pm.PackageManager.GET_SIGNATURES);
        assertNotNull(info.signatures);
        assertEquals(1, info.signatures.length);
        return hash(info.signatures[0].toByteArray());
    }
    static void verifyPackagedOldAssets() throws Exception {
        Context tests = InstrumentationRegistry.getInstrumentation().getContext();
        assertEquals(ZIP_SHA, hash(asset(tests, "upgrade-fixtures/gleam-1.10.5-public.zip")));
        JSONObject manifest = new JSONObject(new String(asset(tests, "upgrade-fixtures/manifest.json"), StandardCharsets.UTF_8));
        JSONObject old = manifest.getJSONObject("versions").getJSONObject("1.10.5");
        assertEquals(ZIP_SHA, old.getString("fixture_sha256"));
        assertEquals("8a96117c98a6b62e5597e8e9cd6efd99a9d413c55f630fd0d665aef4ed063265", old.getString("source_apk_sha256"));
        JSONObject entries = old.getJSONObject("assets");
        assertEquals(28, entries.length());
        for (Iterator<String> names = entries.keys(); names.hasNext();) {
            String name = names.next();
            assertFalse(name.contains("..") || name.contains("\\") || name.startsWith("/"));
            byte[] actual = asset(target(), "public/" + name);
            JSONObject expected = entries.getJSONObject(name);
            assertEquals(expected.getInt("bytes"), actual.length);
            assertEquals("packaged old asset differs: " + name, expected.getString("sha256"), hash(actual));
        }
        assertEquals(INDEX_SHA, hash(asset(target(), "public/index.html")));
    }
    static String js(WebView view, String source) throws Exception {
        CountDownLatch ready = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        ui(() -> view.evaluateJavascript(source, result -> { value.set(result); ready.countDown(); }));
        assertTrue("fixture JS query timed out", ready.await(10, TimeUnit.SECONDS));
        return value.get();
    }
    static String canonicalJson(String encoded) throws Exception {
        return new JSONArray("[" + encoded + "]").toString();
    }
    static void assertJsonEquals(String message, String expected, String actual) throws Exception {
        assertEquals(message, canonicalJson(expected), canonicalJson(actual));
    }
    static void assertJsString(WebView view, String query, String expected) throws Exception {
        assertEquals(query, expected, new JSONArray("[" + js(view, query) + "]").getString(0));
    }
    static void run(WebView view, String body) throws Exception { js(view, "(()=>{" + body + "})()"); }
    static void awaitJs(WebView view, String query, String expected) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        String actual;
        do { actual = js(view, query); if (canonicalJson(expected).equals(canonicalJson(actual))) return; Thread.sleep(50); } while (System.nanoTime() < end);
        assertJsonEquals(query, expected, actual);
    }
}
