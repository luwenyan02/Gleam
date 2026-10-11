package com.gleam.shiguang;

import android.content.Context;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

/** Synthetic, isolated Android WebView capability probe. No application or provider credentials. */
@RunWith(AndroidJUnit4.class)
public class UpgradeWebViewProbeTest {
    private static final String ORIGIN = "https://localhost/";
    private static final String OLD = "<!doctype html><script>localStorage.setItem('upgrade-probe-old-runs',String(Number(localStorage.getItem('upgrade-probe-old-runs')||0)+1));window.probeVersion='old';</script>";
    private static final String CURRENT = "<!doctype html><script>window.probeVersion='new';</script>";
    private static final String SW = "self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open('upgrade-probe-cache').then(c=>c.put('/',new Response(" + quote(OLD) + ",{headers:{'Content-Type':'text/html'}}))));});self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(caches.open('upgrade-probe-cache').then(c=>c.match('/')));});";

    private static String quote(String s) { return org.json.JSONObject.quote(s); }
    private static void ui(Runnable r) { InstrumentationRegistry.getInstrumentation().runOnMainSync(r); }
    private static WebResourceResponse response(WebResourceRequest request) {
        String url = request.getUrl().toString();
        String content = url.equals(ORIGIN + "sw.js") ? SW : CURRENT;
        String mime = url.equals(ORIGIN + "sw.js") ? "application/javascript" : "text/html";
        // Every request is fulfilled in-memory; even unexpected URLs never leave this test.
        return new WebResourceResponse(mime,"UTF-8",new ByteArrayInputStream(content.getBytes(StandardCharsets.UTF_8)));
    }
    private static WebView view() {
        AtomicReference<WebView> ref = new AtomicReference<>();
        ui(() -> {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            WebView w = new WebView(context);
            w.getSettings().setJavaScriptEnabled(true);
            w.getSettings().setDomStorageEnabled(true);
            w.getSettings().setAllowFileAccess(false);
            w.getSettings().setAllowContentAccess(false);
            w.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r) { return response(r); }
            });
            ref.set(w);
        });
        return ref.get();
    }
    private static String js(WebView view,String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        ui(() -> view.evaluateJavascript(script,v->{result.set(v);latch.countDown();}));
        assertTrue("evaluateJavascript timed out",latch.await(10,TimeUnit.SECONDS));
        return result.get();
    }
    private static void await(WebView view,String expression,String expected) throws Exception {
        long end = System.nanoTime()+TimeUnit.SECONDS.toNanos(30);
        String actual = null;
        do { actual = js(view,expression); if(expected.equals(actual))return; Thread.sleep(100); } while(System.nanoTime()<end);
        assertEquals(expression,expected,actual);
    }
    private static void destroy(WebView view) { ui(()->{view.stopLoading();view.destroy();}); }

    @Test public void trustedBaseUrlCanUnregisterWithoutExecutingStaleDocument() throws Exception {
        ui(()->ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest r){return response(r);}
        }));
        WebView old = view(); WebView controlled = null; WebView cleaner = null; WebView current = null;
        try {
            WebView seed = old; ui(()->seed.loadUrl(ORIGIN));
            await(old,"window.probeVersion","\"new\"");
            js(old,"localStorage.setItem('upgrade-probe-sentinel','synthetic-preserve');localStorage.setItem('upgrade-probe-old-runs','0');window.probeReady=false;navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(r=>{window.probeRegistration=r;window.probeReady=true}).catch(()=>window.probeReady='failed');");
            await(old,"window.probeReady","true");
            await(old,"Boolean(window.probeRegistration.active && window.probeRegistration.active.state==='activated' && navigator.serviceWorker.controller===window.probeRegistration.active)","true");
            js(old,"window.probeDb=false;const r=indexedDB.open('upgrade-probe-idb',1);r.onupgradeneeded=()=>r.result.createObjectStore('sentinel');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('sentinel','readwrite');tx.objectStore('sentinel').put('synthetic-ledger-sentinel','keep');tx.oncomplete=()=>{db.close();window.probeDb=true};};");
            await(old,"window.probeDb","true");
            destroy(old); old = null;
            controlled = view(); WebView c = controlled; ui(()->c.loadUrl(ORIGIN));
            await(c,"window.probeVersion","\"old\"");
            await(c,"localStorage.getItem('upgrade-probe-old-runs')","\"1\"");
            destroy(c); controlled = null;
            cleaner = view(); WebView q = cleaner;
            // This is the capability under test, not assumed to have normal-browser semantics.
            ui(()->q.loadDataWithBaseURL(ORIGIN,"<!doctype html><title>native-upgrade-probe</title>","text/html","UTF-8",ORIGIN));
            await(q,"document.title","\"native-upgrade-probe\"");
            assertEquals("true",js(q,"window.isSecureContext"));
            assertEquals("\"object\"",js(q,"typeof navigator.serviceWorker"));
            assertEquals("\"1\"",js(q,"localStorage.getItem('upgrade-probe-old-runs')"));
            js(q,"window.probeClean=false;navigator.serviceWorker.getRegistrations().then(async rs=>{window.probeCount=rs.length;for(const r of rs){if(r.scope!==location.origin+'/')throw Error('scope');const ws=[r.active,r.waiting,r.installing].filter(Boolean);if(!ws.length||ws.some(w=>w.scriptURL!==location.origin+'/sw.js'))throw Error('script');if(!await r.unregister())throw Error('unregister');}if((await navigator.serviceWorker.getRegistrations()).length)throw Error('remaining');window.probeClean=true;}).catch(()=>window.probeClean='failed');");
            await(q,"window.probeClean","true");
            assertEquals("1",js(q,"window.probeCount"));
            destroy(q); cleaner = null;
            current = view(); WebView n = current; ui(()->n.loadUrl(ORIGIN));
            await(n,"window.probeVersion","\"new\"");
            assertEquals("\"1\"",js(n,"localStorage.getItem('upgrade-probe-old-runs')"));
            assertEquals("\"synthetic-preserve\"",js(n,"localStorage.getItem('upgrade-probe-sentinel')"));
            js(n,"window.probeDbRead=null;const r=indexedDB.open('upgrade-probe-idb',1);r.onsuccess=()=>{const db=r.result;const q=db.transaction('sentinel').objectStore('sentinel').get('keep');q.onsuccess=()=>{window.probeDbRead=q.result;db.close();};};");
            await(n,"window.probeDbRead","\"synthetic-ledger-sentinel\"");
        } finally {
            if(old!=null)destroy(old);if(controlled!=null)destroy(controlled);if(cleaner!=null)destroy(cleaner);if(current!=null)destroy(current);
        }
    }
}
