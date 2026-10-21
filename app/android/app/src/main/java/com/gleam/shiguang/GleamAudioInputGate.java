package com.gleam.shiguang;

import java.util.Arrays;

/** Discard samples captured while Android was still choosing the input. Never waits for new samples. */
final class GleamAudioInputGate {
    interface Input { boolean routed(); int discard(byte[] buffer); }
    static boolean discardPending(Input input, int frameBytes) {
        byte[] buffer = new byte[frameBytes];
        try {
            for (int reads = 0; reads < 8; reads++) {
                if (!input.routed()) return false;
                int size = input.discard(buffer);
                if (size < 0 || size > buffer.length || size % 2 != 0 || !input.routed()) return false;
                if (size == 0) return true;
            }
            return false;
        } finally { Arrays.fill(buffer, (byte) 0); }
    }
}
