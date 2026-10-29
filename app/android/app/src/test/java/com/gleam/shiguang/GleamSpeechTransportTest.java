package com.gleam.shiguang;
import static org.junit.Assert.*;
import okhttp3.Request;
import org.junit.Test;
public class GleamSpeechTransportTest {
    @Test public void emptyWorkspaceUsesOfficialSharedServiceWithoutChangingRegion() {
        Request request = GleamSpeechTransport.request("beijing", "", GleamSpeechTransport.MODEL, "fictional_key");
        assertEquals("dashscope.aliyuncs.com", request.url().host());
        assertEquals("/api-ws/v1/realtime", request.url().encodedPath());
        assertEquals(GleamSpeechTransport.MODEL, request.url().queryParameter("model"));
        assertEquals("Bearer fictional_key", request.header("Authorization"));
        assertEquals("https", request.url().scheme());
        assertEquals("wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime", GleamSpeechTransport.endpoint("singapore", "", GleamSpeechTransport.MODEL));
        assertFalse(GleamSpeechTransport.validWorkspace(null));
        assertFalse(GleamSpeechTransport.validWorkspace(" "));
    }
    @Test public void officialWorkspaceRegionOnly() {
        Request request = GleamSpeechTransport.request("beijing", "fictional-workspace", GleamSpeechTransport.MODEL, "fictional_key");
        assertEquals("fictional-workspace.cn-beijing.maas.aliyuncs.com", request.url().host());
        assertEquals("https", request.url().scheme());
        assertEquals("/api-ws/v1/realtime", request.url().encodedPath());
        assertEquals(GleamSpeechTransport.MODEL, request.url().queryParameter("model"));
        assertEquals("Bearer fictional_key", request.header("Authorization"));
        assertTrue(GleamSpeechTransport.endpoint("singapore", "fictional", GleamSpeechTransport.MODEL).startsWith("wss://fictional.ap-southeast-1.maas.aliyuncs.com/"));
        for (String workspace : new String[]{"-invalid", "invalid-", "a.evil", "user@evil", "evil/path", "a?key=secret", new String(new char[64]).replace('\0', 'a')}) assertFalse(GleamSpeechTransport.validWorkspace(workspace));
    }
    @Test(expected = IllegalArgumentException.class) public void rejectsRegionInjectedEndpoint() { GleamSpeechTransport.endpoint("wss://evil.invalid", "fictional", GleamSpeechTransport.MODEL); }
    @Test(expected = IllegalArgumentException.class) public void rejectsUnverifiedModel() { GleamSpeechTransport.endpoint("beijing", "fictional", "arbitrary-model"); }
    @Test public void clientCannotRedirectOrRetryKey() { assertFalse(GleamSpeechTransport.client().followRedirects()); assertFalse(GleamSpeechTransport.client().followSslRedirects()); assertFalse(GleamSpeechTransport.client().retryOnConnectionFailure()); }
    @Test public void validatesSessionAndKeyWithoutEchoing() { assertFalse(GleamSpeechTransport.validKey("a\nsecret")); assertFalse(GleamSpeechTransport.validSessionId("invalid/id")); assertTrue(GleamSpeechTransport.validSessionId("voice_123456")); }
    @Test public void safeProviderCodes() { assertEquals("SPEECH_AUTH", GleamSpeechTransport.statusCode(401)); assertEquals("SPEECH_RATE_LIMIT", GleamSpeechTransport.statusCode(429)); }
}
