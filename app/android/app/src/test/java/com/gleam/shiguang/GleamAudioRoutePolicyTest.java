package com.gleam.shiguang;

import static org.junit.Assert.*;
import org.junit.Test;

public class GleamAudioRoutePolicyTest {
    @Test public void bluetoothMustHaveACommunicationMicrophone() {
        assertTrue(GleamAudioRoutePolicy.bluetooth(7)); assertTrue(GleamAudioRoutePolicy.bluetooth(26));
        for (int output : new int[]{8, 23, 27}) {
            assertTrue(GleamAudioRoutePolicy.wirelessOutput(output));
            assertFalse(GleamAudioRoutePolicy.external(output)); assertEquals(0, GleamAudioRoutePolicy.priority(output));
        }
        assertTrue(GleamAudioRoutePolicy.inputMatches(7, 7)); assertTrue(GleamAudioRoutePolicy.inputMatches(26, 26));
        assertFalse(GleamAudioRoutePolicy.inputMatches(7, 15)); assertFalse(GleamAudioRoutePolicy.inputMatches(26, 15));
        assertFalse(GleamAudioRoutePolicy.inputMatches(7, 26));
    }
    @Test public void wiredAndUsbOutputsKeepPriorityAndUseTheirOwnInputsWhenPresent() {
        assertTrue(GleamAudioRoutePolicy.priority(3) > GleamAudioRoutePolicy.priority(22));
        assertTrue(GleamAudioRoutePolicy.priority(22) > GleamAudioRoutePolicy.priority(7));
        assertTrue(GleamAudioRoutePolicy.inputMatches(3, 3)); assertTrue(GleamAudioRoutePolicy.inputMatches(22, 22));
        assertTrue(GleamAudioRoutePolicy.inputMatches(4, 15)); assertTrue(GleamAudioRoutePolicy.inputMatches(2, 15));
    }
    @Test public void actualOutputMustMatchSelectedSinkId() {
        assertTrue(GleamAudioRoutePolicy.outputMatches(41, 41)); assertFalse(GleamAudioRoutePolicy.outputMatches(41, 42));
    }
}
