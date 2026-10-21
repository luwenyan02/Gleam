package com.gleam.shiguang;

/** Narrow PCM16 converters for legacy 8kHz SCO hardware; network rates remain 16k/24k. */
final class GleamPcmRates {
    private int previous, sum, count;
    private boolean hasPrevious;

    synchronized byte[] input(byte[] bytes, int length) {
        if (length < 0 || length > bytes.length || length % 2 != 0) throw new IllegalArgumentException();
        byte[] result = new byte[length * 2];
        for (int offset = 0, target = 0; offset < length; offset += 2) {
            int sample = (short) ((bytes[offset] & 255) | (bytes[offset + 1] << 8));
            if (!hasPrevious) { previous = sample; hasPrevious = true; }
            put(result, target, (previous + sample) / 2); put(result, target + 2, sample);
            previous = sample; target += 4;
        }
        return result;
    }

    synchronized byte[] output(byte[] bytes) {
        if (bytes.length % 2 != 0) throw new IllegalArgumentException();
        byte[] result = new byte[((bytes.length / 2 + count) / 3) * 2];
        int target = 0;
        for (int offset = 0; offset < bytes.length; offset += 2) {
            sum += (short) ((bytes[offset] & 255) | (bytes[offset + 1] << 8));
            if (++count == 3) { put(result, target, sum / 3); target += 2; sum = count = 0; }
        }
        return result;
    }

    synchronized byte[] finishOutput() {
        byte[] tail = new byte[count == 0 ? 0 : 2];
        if (count != 0) put(tail, 0, sum / count);
        sum = count = 0;
        return tail;
    }
    synchronized void clear() { previous = sum = count = 0; hasPrevious = false; }
    private static void put(byte[] bytes, int offset, int sample) { bytes[offset] = (byte) sample; bytes[offset + 1] = (byte) (sample >> 8); }
}
