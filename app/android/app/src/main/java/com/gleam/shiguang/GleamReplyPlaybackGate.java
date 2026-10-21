package com.gleam.shiguang;

/** Playback lifecycle state; the Audio monitor serializes its caller. No storage or waiting here. */
final class GleamReplyPlaybackGate {
    private long failedGeneration=Long.MIN_VALUE;
    private boolean finished,tailFlushed;
    void prepare(){finished=false;tailFlushed=false;}
    void finish(){finished=true;}
    boolean finished(){return finished;}
    boolean tailPending(int outputRate){return finished&&outputRate==8000&&!tailFlushed;}
    void tailFlushed(){tailFlushed=true;}
    void drained(){finished=false;}
    boolean failed(long generation){return failedGeneration==generation;}
    boolean fail(long generation){if(failed(generation))return false;failedGeneration=generation;return true;}
    void clear(){finished=tailFlushed=false;failedGeneration=Long.MIN_VALUE;}
}
