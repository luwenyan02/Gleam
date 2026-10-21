package com.gleam.shiguang;

import static org.junit.Assert.*;
import org.junit.Test;

public class GleamAudioInputGateTest {
    private static class Input implements GleamAudioInputGate.Input {
        int reads, remaining = 2; boolean routed = true; byte[] discarded;
        public boolean routed() { return routed; }
        public int discard(byte[] bytes) { reads++; discarded = bytes; bytes[0] = 42; return remaining-- > 0 ? bytes.length : 0; }
    }
    @Test public void bufferedUnverifiedSamplesAreDiscardedAndWipedBeforeReady() {
        Input input = new Input(); assertTrue(GleamAudioInputGate.discardPending(input, 640));
        assertEquals(3, input.reads); assertArrayEquals(new byte[640], input.discarded);
    }
    @Test public void continuouslyFullInputHasABoundedFailureInsteadOfWaiting() {
        Input input = new Input(); input.remaining = 100;
        assertFalse(GleamAudioInputGate.discardPending(input, 640)); assertEquals(8, input.reads);
        assertArrayEquals(new byte[640], input.discarded);
    }
    @Test public void inputRouteChangeDuringDiscardCannotOpenTheGate() {
        Input input = new Input() { @Override public int discard(byte[] bytes) { int count = super.discard(bytes); routed = false; return count; } };
        assertFalse(GleamAudioInputGate.discardPending(input, 640)); assertEquals(1, input.reads);
    }
    @Test public void missingRouteAndRecorderErrorsCannotOpenTheGate() {
        Input missing = new Input(); missing.routed = false;
        assertFalse(GleamAudioInputGate.discardPending(missing, 640)); assertEquals(0, missing.reads);
        Input failed = new Input() { @Override public int discard(byte[] bytes) { return -3; } };
        assertFalse(GleamAudioInputGate.discardPending(failed, 640));
    }
}
