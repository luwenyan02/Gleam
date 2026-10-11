package com.gleam.shiguang;

import java.util.Arrays;

/**
 * Prepare and verify before one atomic publication. publish() must either replace the record and
 * return, or fail without replacement. Nothing fallible runs after it returns: post-commit readback
 * cannot falsely report failure while a restart would load the newly committed credential.
 */
final class GleamCredentialPersistence {
    interface Storage {
        void stage(byte[] encrypted) throws Exception;
        byte[] readStaged() throws Exception;
        void publish() throws Exception;
        void discard();
    }
    private final Storage storage;
    GleamCredentialPersistence(Storage storage) { this.storage = storage; }
    void replace(byte[] encrypted) throws Exception {
        boolean published = false;
        try {
            storage.stage(encrypted);
            byte[] verified = storage.readStaged();
            try {
                if (!Arrays.equals(encrypted, verified)) throw new IllegalStateException("SPEECH_KEY_STORAGE");
            } finally { if (verified != null) Arrays.fill(verified, (byte) 0); }
            storage.publish(); // The sole commit point; all validation and fsync already succeeded.
            published = true;
        } finally {
            // A leftover unpublished encrypted staging file is never a credential source on reopen.
            if (!published) { try { storage.discard(); } catch (RuntimeException ignored) {} }
        }
    }
}
