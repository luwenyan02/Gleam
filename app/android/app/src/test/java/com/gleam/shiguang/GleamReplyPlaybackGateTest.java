package com.gleam.shiguang;

import static org.junit.Assert.*;
import org.junit.Test;

public class GleamReplyPlaybackGateTest {
    @Test public void sealedScoReplyStaysPlayingUntilItsPartialSampleGroupIsFlushed(){
        GleamReplyPlaybackGate gate=new GleamReplyPlaybackGate();GleamPcmRates rates=new GleamPcmRates();
        assertArrayEquals(new byte[0],rates.output(new byte[]{100,0,44,1}));gate.finish();
        assertTrue(gate.tailPending(8000));assertFalse(gate.tailPending(24000));
        assertArrayEquals(new byte[]{(byte)200,0},rates.finishOutput());gate.tailFlushed();assertFalse(gate.tailPending(8000));
        assertTrue(gate.finished());gate.drained();assertFalse(gate.finished());
    }
    @Test public void failureNotifiesOnceAndOnlyPausesItsGeneration(){
        GleamReplyPlaybackGate gate=new GleamReplyPlaybackGate();assertTrue(gate.fail(3));
        for(int retry=0;retry<100;retry++){assertTrue(gate.failed(3));assertFalse(gate.fail(3));}
        gate.clear();assertFalse(gate.failed(4));gate.prepare();gate.finish();assertTrue(gate.tailPending(8000));
        assertTrue(gate.fail(4));assertFalse(gate.fail(4));assertTrue(gate.failed(4));
    }
    @Test public void interruptDiscardsOldTailBeforeNextReply(){
        GleamReplyPlaybackGate gate=new GleamReplyPlaybackGate();gate.finish();assertTrue(gate.tailPending(8000));gate.clear();
        assertFalse(gate.finished());assertFalse(gate.tailPending(8000));gate.prepare();gate.finish();assertTrue(gate.tailPending(8000));
    }
}
