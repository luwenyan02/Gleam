package com.gleam.shiguang;

import org.junit.Test;
import org.json.JSONObject;
import static org.junit.Assert.*;

public class GleamUpdateReleaseTest {
    private JSONObject release() throws Exception {
        return new JSONObject("{\"id\":17,\"tag_name\":\"v1.12.0\",\"draft\":false,\"prerelease\":false,\"body\":\"更新说明\",\"assets\":[{\"id\":21,\"name\":\"Gleam-v1.12.0.apk\",\"size\":2048,\"state\":\"uploaded\"},{\"id\":22,\"name\":\"Gleam-v1.12.0.apk.sha256\",\"size\":84,\"state\":\"uploaded\"}]}");
    }
    @Test public void comparesNumericVersionsAndIgnoresOlderReleases() throws Exception {
        assertTrue(GleamUpdateRelease.versionCode("v1.12.0") > GleamUpdateRelease.versionCode("1.9.9"));
        assertNotNull(GleamUpdateRelease.parse(release(), 11104));
        assertNull(GleamUpdateRelease.parse(release(), 11200));
        assertNull(GleamUpdateRelease.parse(release(), 11300));
    }
    @Test public void rejectsAmbiguousVersionsAndNonStableReleases() throws Exception {
        for (String version : new String[]{"v1.12.0-beta", "1.100.0", "1.1.100", "1.2", "01.2.3", "999999999.0.0"}) {
            try { GleamUpdateRelease.versionCode(version); fail(version); } catch (IllegalArgumentException expected) {}
        }
        assertNull(GleamUpdateRelease.parse(release().put("draft", true), 1));
        assertNull(GleamUpdateRelease.parse(release().put("prerelease", true), 1));
    }
    @Test public void requiresMatchingCompleteApkAndChecksum() throws Exception {
        JSONObject r = release(); r.getJSONArray("assets").getJSONObject(0).put("name", "other.apk");
        try { GleamUpdateRelease.parse(r, 1); fail(); } catch (IllegalArgumentException expected) {}
        r = release(); r.getJSONArray("assets").getJSONObject(1).put("state", "new");
        try { GleamUpdateRelease.parse(r, 1); fail(); } catch (IllegalArgumentException expected) {}
        r = release(); r.getJSONArray("assets").put(r.getJSONArray("assets").getJSONObject(0));
        try { GleamUpdateRelease.parse(r, 1); fail(); } catch (IllegalArgumentException expected) {}
    }
    @Test public void checksumMustIdentifyTheSelectedFile() {
        String digest = "a".repeat(64);
        assertEquals(digest, GleamUpdateRelease.checksum(digest+"  Gleam-v1.12.0.apk\n", "Gleam-v1.12.0.apk"));
        for (String value : new String[]{digest+"  other.apk", "bad", digest+"  ../Gleam-v1.12.0.apk", digest+"\n"+digest}) {
            try { GleamUpdateRelease.checksum(value, "Gleam-v1.12.0.apk"); fail(); } catch (IllegalArgumentException expected) {}
        }
    }
    @Test public void restrictsRedirectHostsAndNeverAuthenticatesCdn() {
        assertTrue(GleamUpdateRelease.allowedDownload("https://release-assets.githubusercontent.com/github-production-release-asset/123?sig=example"));
        assertTrue(GleamUpdateRelease.allowedDownload("https://objects.githubusercontent.com/file"));
        for (String url : new String[]{"http://release-assets.githubusercontent.com/file", "https://evil.test/file", "https://release-assets.githubusercontent.com.evil.test/file", "https://user@objects.githubusercontent.com/file", "https://objects.githubusercontent.com:444/file", "https://api.github.com/repos/other/repo/assets/1"}) assertFalse(url, GleamUpdateRelease.allowedDownload(url));
    }
}
