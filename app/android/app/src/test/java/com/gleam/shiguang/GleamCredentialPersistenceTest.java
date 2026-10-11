package com.gleam.shiguang;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;

/** Fault injection at the production publication boundary, including reopening after each result. */
public class GleamCredentialPersistenceTest {
    private static final byte[] OLD = "synthetic-old-encrypted-record".getBytes(StandardCharsets.UTF_8);
    private static final byte[] NEW = "synthetic-new-encrypted-record".getBytes(StandardCharsets.UTF_8);
    static final class Disk implements GleamCredentialPersistence.Storage {
        byte[] current = OLD.clone(), staged;
        String failAt;
        boolean failCleanup, unreadableAfterPublish;
        int stages, verifications, publications, discards;
        public void stage(byte[] bytes) throws Exception {
            stages++; staged = bytes.clone();
            if ("write".equals(failAt)) throw new Exception("write or fsync failed");
        }
        public byte[] readStaged() throws Exception {
            verifications++;
            if ("verify".equals(failAt) || unreadableAfterPublish && publications > 0) throw new Exception("read failed");
            return "mismatch".equals(failAt) ? OLD.clone() : staged.clone();
        }
        public void publish() throws Exception {
            if ("rename".equals(failAt)) throw new Exception("atomic rename failed without replacement");
            current = staged; staged = null; publications++;
        }
        public void discard() { discards++; if (failCleanup) throw new IllegalStateException("cleanup failed"); staged = null; }
        byte[] reopen() { return current.clone(); }
    }
    @Test public void writeFsyncVerificationMismatchAndRenameFailuresPreserveOldOnReopen() throws Exception {
        for (String failure : new String[]{"write", "verify", "mismatch", "rename"}) for (boolean cleanupFails : new boolean[]{false, true}) {
            Disk disk = new Disk(); disk.failAt = failure; disk.failCleanup = cleanupFails;
            try { new GleamCredentialPersistence(disk).replace(NEW.clone()); fail("expected " + failure); }
            catch (Exception expected) {}
            assertArrayEquals(OLD, disk.reopen()); assertEquals(0, disk.publications); assertEquals(1, disk.discards);
        }
    }
    @Test public void successfulPublicationIsNotReclassifiedByUnavailablePostCommitReadback() throws Exception {
        Disk disk = new Disk(); disk.unreadableAfterPublish = true; disk.failCleanup = true;
        new GleamCredentialPersistence(disk).replace(NEW.clone());
        assertEquals(1, disk.verifications); assertEquals(1, disk.publications); assertEquals(0, disk.discards);
        assertArrayEquals(NEW, disk.reopen());
        try { disk.readStaged(); fail("post-commit readback fixture must fail"); } catch (Exception expected) {}
        // The transaction never invokes that fallible read after publication and reports success.
        assertArrayEquals(NEW, disk.reopen());
    }
    @Test public void failedCleanupLeavesOnlyUnpublishedStagingNeverUsedOnRestart() throws Exception {
        Disk disk = new Disk(); disk.failAt = "verify"; disk.failCleanup = true;
        try { new GleamCredentialPersistence(disk).replace(NEW.clone()); fail("verification should fail"); } catch (Exception expected) {}
        assertNotNull(disk.staged); assertArrayEquals(OLD, disk.reopen());
        disk.failAt = null; disk.failCleanup = false;
        new GleamCredentialPersistence(disk).replace(NEW.clone()); assertArrayEquals(NEW, disk.reopen());
    }
    @Test public void verificationBuffersAreErasedWithoutChangingStagedOrPublishedBytes() throws Exception {
        Disk disk = new Disk(); byte[] caller = NEW.clone(); new GleamCredentialPersistence(disk).replace(caller);
        assertArrayEquals(NEW, caller); assertArrayEquals(NEW, disk.reopen()); assertFalse(Arrays.equals(OLD, disk.reopen()));
    }
}
