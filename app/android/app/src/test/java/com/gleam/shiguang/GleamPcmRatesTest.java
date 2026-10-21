package com.gleam.shiguang;

import static org.junit.Assert.*;
import org.junit.Test;

public class GleamPcmRatesTest {
    private static byte[] pcm(int... samples) {
        byte[] bytes = new byte[samples.length * 2];
        for (int i = 0; i < samples.length; i++) { bytes[i * 2] = (byte) samples[i]; bytes[i * 2 + 1] = (byte) (samples[i] >> 8); }
        return bytes;
    }
    @Test public void legacyCaptureKeepsTheNetworkFrameAndThirtySecondLimits() {
        GleamPcmRates rates = new GleamPcmRates();
        assertEquals(GleamSpeechSession.FRAME_BYTES, rates.input(new byte[1600], 1600).length);
        assertEquals(640, rates.input(new byte[320], 320).length);
        int bytes = 0;
        for (int frame = 0; frame < 300; frame++) bytes += rates.input(new byte[1600], 1600).length;
        assertEquals(16000 * 2 * 30, bytes);
    }
    @Test public void captureInterpolationPreservesSignedExtremesAcrossFramesAndClears() {
        GleamPcmRates rates = new GleamPcmRates();
        assertArrayEquals(pcm(-32768, -32768), rates.input(pcm(-32768), 2));
        assertArrayEquals(pcm(0, 32767), rates.input(pcm(32767), 2));
        rates.clear();
        assertArrayEquals(pcm(100, 100), rates.input(pcm(100), 2));
    }
    @Test public void playbackRetainsPartialGroupsUntilFinishAndResetDiscardsThem() {
        GleamPcmRates rates = new GleamPcmRates();
        assertArrayEquals(new byte[0], rates.output(pcm(300, 600)));
        assertArrayEquals(pcm(600, -32768), rates.output(pcm(900, -32768, -32768, -32768)));
        assertArrayEquals(new byte[0], rates.finishOutput());
        assertArrayEquals(new byte[0], rates.output(pcm(100, 300)));
        assertArrayEquals(pcm(200), rates.finishOutput());
        assertArrayEquals(new byte[0], rates.finishOutput());
        rates.output(pcm(999, 999)); rates.clear();
        assertArrayEquals(pcm(3), rates.output(pcm(3, 3, 3)));
    }
    @Test public void twentyFourKhzReplyStaysOneSecondOnEightKhzHardware() {
        GleamPcmRates rates = new GleamPcmRates(); int bytes = 0;
        for (int chunk = 0; chunk < 75; chunk++) bytes += rates.output(new byte[640]).length;
        bytes += rates.finishOutput().length;
        assertEquals(8000 * 2, bytes);
    }
}
