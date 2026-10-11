package com.gleam.shiguang;

import java.util.concurrent.CopyOnWriteArrayList;

/** One transaction boundary for main-key mutation and candidate test/commit revision checks. */
final class GleamCredentialLock {
    static final Object LOCK = new Object();
    private static final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();
    static void add(Runnable listener) { listeners.add(listener); }
    static void remove(Runnable listener) { listeners.remove(listener); }
    static void changed() { for (Runnable listener : listeners) listener.run(); }
    private GleamCredentialLock() {}
}
