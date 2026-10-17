package com.gleam.shiguang;

/** Persist before SMTP. Pending after a crash is uncertain, never automatically resent. */
final class GleamMailLedger {
    interface Store { String get(String key); void put(String key, String value) throws Exception; }
    interface Send { void run() throws Exception; }
    private final Store store;
    GleamMailLedger(Store store) { this.store = store; }
    synchronized void send(String id, String digest, Send action) throws Exception {
        if (id == null || !id.matches("[A-Za-z0-9-]{8,80}")) throw new IllegalArgumentException("INVALID");
        String existing = store.get(id);
        if ((digest + ":accepted").equals(existing)) return;
        if (existing != null) throw new IllegalStateException("UNCERTAIN");
        store.put(id, digest + ":pending");
        action.run();
        store.put(id, digest + ":accepted");
    }
}
