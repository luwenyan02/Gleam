package com.gleam.shiguang;

/** Small, Android-free policy. A generation is invalidated before disposing its WebView. */
final class GleamBootState {
    static final String ROOT = "https://localhost/";
    enum Phase { CLOSED, RUNNING, PAUSED, FAILED, OPEN, DESTROYED }

    private Phase phase = Phase.CLOSED;
    private long generation;
    private boolean initialLoadRequested;

    static boolean isCanonicalRoot(String url) {
        return ROOT.equals(url) || "https://localhost".equals(url);
    }

    synchronized void requestInitialLoad(String url) {
        if (phase != Phase.OPEN && phase != Phase.DESTROYED && isCanonicalRoot(url)) {
            initialLoadRequested = true;
        }
    }

    synchronized boolean hasInitialLoad() { return initialLoadRequested; }
    synchronized boolean isOpen() { return phase == Phase.OPEN; }
    synchronized Phase phase() { return phase; }

    synchronized long begin() {
        if (phase == Phase.OPEN || phase == Phase.DESTROYED) return -1;
        phase = Phase.RUNNING;
        return ++generation;
    }

    synchronized boolean isRunning(long token) {
        return phase == Phase.RUNNING && generation == token;
    }

    synchronized boolean complete(long token) {
        if (!isRunning(token) || !initialLoadRequested) return false;
        phase = Phase.OPEN;
        ++generation;
        return true;
    }

    synchronized boolean fail(long token) {
        if (!isRunning(token)) return false;
        phase = Phase.FAILED;
        ++generation;
        return true;
    }

    synchronized void closeAfterLoadFailure() {
        if (phase == Phase.OPEN) { phase = Phase.FAILED; ++generation; }
    }

    synchronized void pause() {
        if (phase == Phase.RUNNING) { phase = Phase.PAUSED; ++generation; }
    }

    synchronized void destroy() { phase = Phase.DESTROYED; ++generation; }
}
