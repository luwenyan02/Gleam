package com.gleam.shiguang;

/** An inactive output has no routed device yet; a known different device must never receive reply PCM. */
final class GleamPlaybackRouteGate {
    enum Action { READY, PRIME, FAIL }
    private long deadline = -1;
    Action poll(boolean active, boolean missing, boolean matches, long now) {
        if (!active || (!missing && !matches) || (deadline >= 0 && now >= deadline)) return Action.FAIL;
        if (!missing) { deadline = -1; return Action.READY; }
        if (deadline < 0) deadline = now + 5000;
        return Action.PRIME;
    }
}
