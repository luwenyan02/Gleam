package com.gleam.shiguang;

import org.junit.Test;
import static org.junit.Assert.*;

public class GleamBootStateTest {
    @Test public void onlyExactInitialRootIsAccepted() {
        assertTrue(GleamBootState.isCanonicalRoot("https://localhost"));
        assertTrue(GleamBootState.isCanonicalRoot("https://localhost/"));
        for (String url : new String[] {null, "https://localhost/?q=x", "https://localhost/#x", "https://localhost:443/",
            "https://user@localhost/", "http://localhost/", "HTTPS://localhost/", "https://localhost/path", "javascript:alert(1)", "data:text/html,x"}) {
            assertFalse(String.valueOf(url), GleamBootState.isCanonicalRoot(url));
        }
    }
    @Test public void initialLoadsCoalesceAndOnlyOneGenerationCanOpen() {
        GleamBootState state = new GleamBootState();
        state.requestInitialLoad(GleamBootState.ROOT);
        state.requestInitialLoad("javascript:old()");
        state.requestInitialLoad("https://localhost");
        long first = state.begin();
        long retry = state.begin();
        assertFalse(state.complete(first));
        assertTrue(state.complete(retry));
        assertTrue(state.isOpen());
        assertFalse(state.complete(retry));
        assertEquals(-1, state.begin());
    }
    @Test public void pauseFailureAndDestructionInvalidateCallbacks() {
        GleamBootState state = new GleamBootState();
        state.requestInitialLoad(GleamBootState.ROOT);
        long paused = state.begin();
        state.pause();
        assertFalse(state.complete(paused));
        long failed = state.begin();
        assertTrue(state.fail(failed));
        assertFalse(state.complete(failed));
        long destroyed = state.begin();
        state.destroy();
        assertFalse(state.complete(destroyed));
        assertEquals(-1, state.begin());
        assertEquals(GleamBootState.Phase.DESTROYED, state.phase());
    }
    @Test public void cleanupCannotOpenWithoutCapacitorInitialLoad() {
        GleamBootState state = new GleamBootState();
        long token = state.begin();
        assertFalse(state.complete(token));
        assertTrue(state.isRunning(token));
        state.requestInitialLoad("https://localhost/foreign");
        assertFalse(state.hasInitialLoad());
        assertFalse(state.complete(token));
    }

    @Test public void failedRootLoadReclosesAndAllowsBoundedRetry() {
        GleamBootState state = new GleamBootState();
        state.requestInitialLoad(GleamBootState.ROOT);
        long first = state.begin();
        assertTrue(state.complete(first));
        state.closeAfterLoadFailure();
        assertFalse(state.isOpen());
        assertEquals(GleamBootState.Phase.FAILED, state.phase());
        assertFalse(state.complete(first));
        assertTrue(state.complete(state.begin()));
    }
}
