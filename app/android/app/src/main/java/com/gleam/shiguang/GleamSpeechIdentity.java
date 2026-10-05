package com.gleam.shiguang;
import java.util.LinkedHashSet;

/** Isolation, never authorization: consent and runtime permission are checked separately. */
final class GleamSpeechIdentity {
    private final LinkedHashSet<String> ended = new LinkedHashSet<>();
    private String activeId, activeRevision;
    synchronized boolean reserve(String id, String expectedRevision, String actualRevision) {
        if (activeId != null || ended.contains(id) || expectedRevision == null || !expectedRevision.equals(actualRevision)) return false;
        activeId = id; activeRevision = expectedRevision; return true;
    }
    synchronized boolean isEnded(String id) { return ended.contains(id); }
    synchronized boolean mayContinue(String id, String actualRevision, boolean foreground, boolean destroyed) {
        return !destroyed && foreground && activeId != null && activeId.equals(id) && activeRevision.equals(actualRevision);
    }
    synchronized void end(String id) {
        if (id != null && id.equals(activeId)) { activeId = null; activeRevision = null; }
        ended.add(id); while (ended.size() > 128) ended.remove(ended.iterator().next());
    }
}
