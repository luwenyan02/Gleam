package com.gleam.shiguang;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class GleamUpdateCacheTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private final byte[] apk = "synthetic signed APK stand-in".getBytes(StandardCharsets.UTF_8);
    private GleamUpdateRelease release() throws Exception {
        return GleamUpdateRelease.parse(new JSONObject("{\"id\":17,\"tag_name\":\"v1.12.0\",\"draft\":false,\"prerelease\":false,\"body\":\"更新说明\",\"assets\":[{\"id\":21,\"name\":\"Gleam-v1.12.0.apk\",\"size\":"+apk.length+",\"state\":\"uploaded\"},{\"id\":22,\"name\":\"Gleam-v1.12.0.apk.sha256\",\"size\":84,\"state\":\"uploaded\"}]}"), 11112);
    }
    private String hash() throws Exception {
        StringBuilder out = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(apk)) out.append(String.format("%02x", b & 255));
        return out.toString();
    }
    private GleamUpdateCache complete(File directory) throws Exception {
        GleamUpdateCache cache = new GleamUpdateCache(directory);
        Files.write(cache.apk().toPath(), apk);
        cache.commit(release(), hash());
        return cache;
    }
    @Test public void restoresAcrossInstancesAndRevalidatesThePackageOffline() throws Exception {
        File directory = temporary.newFolder(); complete(directory);
        AtomicInteger validations = new AtomicInteger();
        GleamUpdateCache.Record restored = new GleamUpdateCache(directory).restore(11112, (file, release) -> {
            assertArrayEquals(apk, Files.readAllBytes(file.toPath()));
            assertEquals(11200, release.code); validations.incrementAndGet();
        });
        assertNotNull(restored); assertEquals(17, restored.release.id);
        assertEquals(hash(), restored.hash); assertEquals(1, validations.get());
    }
    @Test public void interruptedDownloadNeverBecomesReadyAndIsCleaned() throws Exception {
        GleamUpdateCache cache = new GleamUpdateCache(temporary.newFolder());
        Files.write(cache.part().toPath(), apk);
        assertNull(cache.restore(11112, (file, release) -> fail("partial APK must not be verified")));
        assertFalse(cache.part().exists());
        Files.write(cache.apk().toPath(), apk);
        assertNull(cache.restore(11112, (file, release) -> fail("missing manifest")));
        assertFalse(cache.apk().exists());
    }
    @Test public void rejectsTamperedOrTruncatedApkAndMissingOrCorruptManifest() throws Exception {
        for (int scenario = 0; scenario < 4; scenario++) {
            File directory = temporary.newFolder(); GleamUpdateCache cache = complete(directory);
            if (scenario == 0) { byte[] changed = apk.clone(); changed[0] ^= 1; Files.write(cache.apk().toPath(), changed); }
            if (scenario == 1) Files.write(cache.apk().toPath(), new byte[]{1});
            if (scenario == 2) new File(directory, "ready.json").delete();
            if (scenario == 3) Files.write(new File(directory, "ready.json").toPath(), "{".getBytes(StandardCharsets.UTF_8));
            assertNull(cache.restore(11112, (file, release) -> fail("invalid cache")));
            assertFalse(cache.apk().exists());
        }
    }
    @Test public void rejectsAlreadyInstalledVersionOrFailedPackageSignatureValidation() throws Exception {
        GleamUpdateCache cache = complete(temporary.newFolder());
        assertNull(cache.restore(11200, (file, release) -> fail("old version")));
        cache = complete(temporary.newFolder());
        assertNull(cache.restore(11112, (file, release) -> { throw new Exception("package/signature mismatch"); }));
        assertFalse(cache.apk().exists());
    }
    @Test public void clearRemovesReadyAndPartialFilesAndMetadata() throws Exception {
        File directory = temporary.newFolder(); GleamUpdateCache cache = complete(directory);
        Files.write(cache.part().toPath(), apk);
        Files.write(new File(directory, "ready.json.part").toPath(), apk);
        cache.clear();
        assertEquals(0, directory.list().length);
    }
}
