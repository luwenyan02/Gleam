package com.gleam.shiguang;

import static org.junit.Assert.*;
import org.junit.Test;

public class GleamPlaybackRouteGateTest {
    @Test public void temporarilyMissingOutputPrimesBeforeAllowingReplyPcm() {
        GleamPlaybackRouteGate gate = new GleamPlaybackRouteGate();
        assertEquals(GleamPlaybackRouteGate.Action.PRIME, gate.poll(true, true, false, 100));
        assertEquals(GleamPlaybackRouteGate.Action.READY, gate.poll(true, false, true, 125));
    }
    @Test public void repeatedNullOutputCannotExtendTheFiveSecondDeadline() {
        GleamPlaybackRouteGate gate = new GleamPlaybackRouteGate();
        assertEquals(GleamPlaybackRouteGate.Action.PRIME, gate.poll(true, true, false, 100));
        assertEquals(GleamPlaybackRouteGate.Action.PRIME, gate.poll(true, true, false, 5099));
        assertEquals(GleamPlaybackRouteGate.Action.FAIL, gate.poll(true, true, false, 5100));
    }
    @Test public void knownWrongDeviceAndInactiveCommunicationRouteFailWithoutPriming() {
        GleamPlaybackRouteGate gate = new GleamPlaybackRouteGate();
        assertEquals(GleamPlaybackRouteGate.Action.FAIL, gate.poll(true, false, false, 100));
        assertEquals(GleamPlaybackRouteGate.Action.FAIL, gate.poll(false, true, false, 100));
        assertEquals(GleamPlaybackRouteGate.Action.FAIL, gate.poll(false, false, true, 100));
    }
}
