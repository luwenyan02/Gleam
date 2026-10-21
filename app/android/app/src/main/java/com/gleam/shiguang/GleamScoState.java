package com.gleam.shiguang;

/** Sticky SCO broadcasts describe the system, but only our own SCO request may gate this session. */
final class GleamScoState {
    private int lastState;
    private boolean requested, connected;
    void requested() { requested = true; connected = lastState == 1; }
    boolean observed(int state) {
        lastState = state;
        if (!requested) return false;
        boolean lost = connected && state != 1;
        connected = state == 1;
        return lost;
    }
    boolean connected() { return requested && connected; }
}
