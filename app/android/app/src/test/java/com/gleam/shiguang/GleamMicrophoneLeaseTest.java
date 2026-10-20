package com.gleam.shiguang;

import static org.junit.Assert.*;
import org.junit.Test;

public class GleamMicrophoneLeaseTest {
    @Test public void shortVoiceAndLiveChatCannotOwnTheMicrophoneTogether() {
        Object shortVoice=new Object(),liveChat=new Object();
        try {
            assertTrue(GleamMicrophoneLease.acquire(shortVoice));assertFalse(GleamMicrophoneLease.acquire(liveChat));
            GleamMicrophoneLease.release(liveChat);assertFalse(GleamMicrophoneLease.acquire(liveChat));
            GleamMicrophoneLease.release(shortVoice);assertTrue(GleamMicrophoneLease.acquire(liveChat));
            assertFalse(GleamMicrophoneLease.acquire(shortVoice));
        }finally{GleamMicrophoneLease.release(shortVoice);GleamMicrophoneLease.release(liveChat);}
    }
}
