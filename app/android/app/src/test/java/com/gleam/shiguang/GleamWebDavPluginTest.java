package com.gleam.shiguang;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import java.nio.charset.StandardCharsets;
import okio.Buffer;
import okhttp3.Request;
import org.junit.Test;

public class GleamWebDavPluginTest {
    @Test
    public void propfindKeepsCustomMethodXmlBodyAndHeaders() throws Exception {
        byte[] xml = "<propfind xmlns=\"DAV:\"/>".getBytes(StandardCharsets.UTF_8);

        Request request = GleamWebDavPlugin.buildRequest(
            "https://example.invalid/dav/%E6%8B%BE%E5%85%89/",
            "PROPFIND",
            "Basic ZmljdGlvbjpwYXNzd29yZA==",
            "0",
            "application/xml; charset=utf-8",
            xml
        );

        assertEquals("PROPFIND", request.method());
        assertEquals("0", request.header("Depth"));
        assertEquals("Basic ZmljdGlvbjpwYXNzd29yZA==", request.header("Authorization"));
        assertEquals("/dav/%E6%8B%BE%E5%85%89/", request.url().encodedPath());
        Buffer sink = new Buffer();
        request.body().writeTo(sink);
        assertArrayEquals(xml, sink.readByteArray());
    }

    @Test
    public void nativeClientNeverFollowsRedirects() {
        assertFalse(GleamWebDavPlugin.createClient().followRedirects());
        assertFalse(GleamWebDavPlugin.createClient().followSslRedirects());
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsPlainHttpBecauseBasicAuthMustUseTls() {
        GleamWebDavPlugin.buildRequest(
            "http://example.invalid/dav/",
            "PROPFIND",
            "Basic ZmljdGlvbjpwYXNzd29yZA==",
            "0",
            "application/xml",
            new byte[0]
        );
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsEncodedRequestBodiesAboveBridgeLimitWithoutAllocatingThem() {
        GleamWebDavPlugin.validateEncodedBodyLength(GleamWebDavPlugin.MAX_ENCODED_BODY_CHARS + 1);
    }
}
