package com.gleam.shiguang;

import java.util.function.BooleanSupplier;

/**
 * Authorization at the irreversible operation, not just at a preceding state check.
 * Main-key mutation and lifecycle revocation use the same lock. Code holding that lock must never
 * acquire the speech-engine or audio monitor: engine/audio -> authorization is the sole lock order.
 */
final class GleamSpeechAuthorization {
    private final Object lock;
    private final BooleanSupplier allowed;
    GleamSpeechAuthorization(Object lock, BooleanSupplier allowed) { this.lock = lock; this.allowed = allowed; }
    boolean allowed() { synchronized (lock) { return allowed.getAsBoolean(); } }
    boolean send(BooleanSupplier operation) {
        synchronized (lock) { return allowed.getAsBoolean() && operation.getAsBoolean(); }
    }
    void activate(Runnable operation) {
        synchronized (lock) {
            if (!allowed.getAsBoolean()) throw new IllegalStateException("SPEECH_INTERRUPTED");
            operation.run();
        }
    }
}
