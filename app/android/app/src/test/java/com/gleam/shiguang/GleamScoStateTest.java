package com.gleam.shiguang;

import static org.junit.Assert.*;
import org.junit.Test;

public class GleamScoStateTest {
    @Test public void initialDisconnectedStickyCannotEndPhoneOrWiredCapture() {
        GleamScoState state = new GleamScoState();
        assertFalse(state.observed(0)); assertFalse(state.observed(1)); assertFalse(state.observed(0));
        assertFalse(state.connected());
    }
    @Test public void ownRequestWaitsForConnectedAndThenDetectsDisconnect() {
        GleamScoState state = new GleamScoState();
        state.observed(0); state.requested();
        assertFalse(state.observed(2)); assertFalse(state.observed(0)); assertFalse(state.connected());
        assertFalse(state.observed(1)); assertTrue(state.connected());
        assertTrue(state.observed(0)); assertFalse(state.connected());
    }
    @Test public void alreadyConnectedStickyOnlyBecomesReadyAfterAcquiringOwnRequest() {
        GleamScoState state = new GleamScoState();
        assertFalse(state.observed(1)); assertFalse(state.connected());
        state.requested(); assertTrue(state.connected());
        assertTrue(state.observed(0)); assertFalse(state.connected());
    }
}
