package com.gleam.shiguang;

import java.util.Arrays;
import java.util.Objects;
import java.util.UUID;

/** Two-phase, memory-only candidate authority. The lock is also held by both native secret stores. */
final class GleamSpeechCandidateGate {
    interface Store {
        String revision();
        String mainRevision();
        String independentKey() throws Exception;
        String mainKey() throws Exception;
        Receipt commit(String key, String source, String mainRevision, Config config) throws Exception;
    }
    static final class Config {
        final String region, workspace, model;
        Config(String region, String workspace, String model) { this.region = region; this.workspace = workspace; this.model = model; }
        void validate() { GleamSpeechTransport.endpoint(region, workspace, model); }
        @Override public boolean equals(Object other) {
            if (!(other instanceof Config)) return false;
            Config that = (Config) other;
            return Objects.equals(region, that.region) && Objects.equals(workspace, that.workspace) && Objects.equals(model, that.model);
        }
        @Override public int hashCode() { return Objects.hash(region, workspace, model); }
    }
    /** A sanitized commit receipt prepared before publication; contains no readable credential. */
    static final class Receipt {
        final String credentialRevision, mainCredentialRevision, keySource, maskedKey, maskedMainKey;
        final boolean hasMainKey;
        final Config activeConfig;
        Receipt(String revision, String mainRevision, String source, String maskedKey, String maskedMainKey, boolean hasMainKey, Config config) {
            this.credentialRevision = revision; this.mainCredentialRevision = mainRevision; this.keySource = source;
            this.maskedKey = maskedKey; this.maskedMainKey = maskedMainKey; this.hasMainKey = hasMainKey; this.activeConfig = config;
        }
    }
    static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
    }
    private static final class Candidate {
        final String id, revision, mainRevision, configurationId, source;
        final Config config;
        final char[] key;
        String token;
        Candidate(String id, String revision, String mainRevision, String configurationId, String source, String key, Config config) {
            this.id = id; this.revision = revision; this.mainRevision = mainRevision; this.configurationId = configurationId;
            this.source = source; this.key = key.toCharArray(); this.config = config;
        }
        void erase() { Arrays.fill(key, '\0'); token = null; }
    }
    private final Store store;
    private final Object lock;
    private String configurationId;
    private Candidate candidate;
    GleamSpeechCandidateGate(Store store, Object lock) { this.store = store; this.lock = lock; }
    void invalidateConfiguration(String id) {
        synchronized (lock) { clear(); configurationId = id; }
    }
    void begin(String id, String revision, String mainRevision, String configId, String source, String value, Config config) throws Failure {
        synchronized (lock) {
            if (candidate != null) throw new Failure("SPEECH_BUSY");
            if (!GleamSpeechTransport.validSessionId(id) || !Objects.equals(configurationId, configId) || configId == null) throw new Failure("SPEECH_SESSION_INVALID");
            if (!Objects.equals(store.revision(), revision) || !Objects.equals(store.mainRevision(), mainRevision)) throw new Failure("SPEECH_KEY_CHANGED");
            if (!"separate".equals(source) && !"shared".equals(source)) throw new Failure("SPEECH_CONFIG_INVALID");
            try { config.validate(); } catch (RuntimeException error) { throw new Failure("SPEECH_CONFIG_INVALID"); }
            final String key;
            try { key = "shared".equals(source) ? store.mainKey() : value == null || value.isEmpty() ? store.independentKey() : value; }
            catch (Exception ignored) { throw new Failure("SPEECH_KEY_STORAGE"); }
            if (!GleamSpeechTransport.validKey(key)) throw new Failure("SPEECH_KEY_REQUIRED");
            // A shared test never accepts a caller-supplied replacement masquerading as the main key.
            if ("shared".equals(source) && value != null && !value.isEmpty()) throw new Failure("SPEECH_CONFIG_INVALID");
            candidate = new Candidate(id, revision, mainRevision, configId, source, key, config);
        }
    }
    String transportKey(String id) throws Failure {
        synchronized (lock) { Candidate value = current(id, true, false); return new String(value.key); }
    }
    String acknowledge(String id, boolean foreground, boolean destroyed) throws Failure {
        synchronized (lock) {
            Candidate value = current(id, foreground, destroyed);
            if (value.token != null) { clear(); throw new Failure("SPEECH_SESSION_INVALID"); }
            value.token = UUID.randomUUID().toString(); return value.token;
        }
    }
    Receipt commit(String id, String token, String revision, String mainRevision, String configId, boolean foreground, boolean destroyed) throws Failure {
        synchronized (lock) {
            Candidate value = current(id, foreground, destroyed);
            if (value.token == null || !value.token.equals(token) || !Objects.equals(value.revision, revision)
                || !Objects.equals(value.mainRevision, mainRevision) || !Objects.equals(value.configurationId, configId)) throw new Failure("SPEECH_SESSION_INVALID");
            try {
                // Linearization point: no main-key write, configuration invalidation, or second commit can
                // interleave between these revision checks and the atomic encrypted snapshot replacement.
                return store.commit(new String(value.key), value.source, value.mainRevision, value.config);
            } catch (Exception ignored) { throw new Failure("SPEECH_KEY_STORAGE"); }
            finally { clear(); }
        }
    }
    private Candidate current(String id, boolean foreground, boolean destroyed) throws Failure {
        if (candidate == null || !candidate.id.equals(id)) throw new Failure("SPEECH_SESSION_INVALID");
        if (!foreground || destroyed) { clear(); throw new Failure("SPEECH_INTERRUPTED"); }
        if (!Objects.equals(candidate.configurationId, configurationId)) { clear(); throw new Failure("SPEECH_SESSION_INVALID"); }
        if (!candidate.revision.equals(store.revision()) || !candidate.mainRevision.equals(store.mainRevision())) { clear(); throw new Failure("SPEECH_KEY_CHANGED"); }
        return candidate;
    }
    void cancel(String id) { synchronized (lock) { if (candidate != null && candidate.id.equals(id)) clear(); } }
    void cancelAll() { synchronized (lock) { clear(); } }
    private void clear() { if (candidate != null) { candidate.erase(); candidate = null; } }
    static String mask(String value) {
        if (value == null || value.isEmpty()) return "";
        int count = value.codePointCount(0, value.length());
        if (count <= 15) return "••••••";
        return value.substring(0, value.offsetByCodePoints(0, 5)) + "••••••" + value.substring(value.offsetByCodePoints(0, count - 5));
    }
}
