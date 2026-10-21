package com.gleam.shiguang;

/** Pure selection/readiness rules. Device IDs are compared only within the same input/output side. */
final class GleamAudioRoutePolicy {
    static boolean bluetooth(int type) { return type == 7 || type == 26; }
    static boolean wirelessOutput(int type) { return bluetooth(type) || type == 8 || type == 23 || type == 27; }
    static boolean external(int type) { return bluetooth(type) || type == 3 || type == 4 || type == 11 || type == 12 || type == 22; }
    static int priority(int type) {
        if (type == 3 || type == 4) return 4;
        if (type == 11 || type == 12 || type == 22) return 3;
        return bluetooth(type) ? 2 : 0;
    }
    static boolean inputMatches(int outputType, int inputType) {
        if (bluetooth(outputType)) return inputType == outputType;
        if (outputType == 3) return inputType == 3;
        if (outputType == 11 || outputType == 12 || outputType == 22) return inputType == outputType;
        return inputType == 15; // Built-in speaker/earpiece or headphones without a microphone.
    }
    static boolean outputMatches(int expectedId, int actualId) { return expectedId == actualId; }
}
