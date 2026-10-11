package com.gleam.shiguang;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.system.Os;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Native-only credential snapshots. One atomic encrypted record binds key, source and destination. */
final class GleamSpeechCredentials implements GleamSpeechCandidateGate.Store {
    static final String SECRET_NAME = "voice.bailian.apiKey";
    private static final String KEY_ALIAS = "gleam_voice_bailian_v1";
    private final Context context;
    private final SharedPreferences legacy;
    private final File file;
    private final GleamCredentialPersistence persistence;
    private String revision = UUID.randomUUID().toString();
    private String observedMainRevision;
    private Snapshot snapshot;
    private boolean loaded;
    private static final class Snapshot {
        final String payload, source, mainRevision;
        final GleamSpeechCandidateGate.Config config;
        Snapshot(String payload, String source, String mainRevision, GleamSpeechCandidateGate.Config config) {
            this.payload = payload; this.source = source; this.mainRevision = mainRevision; this.config = config;
        }
    }
    GleamSpeechCredentials(Context context) {
        this.context = context.getApplicationContext();
        legacy = context.getSharedPreferences("gleam_secure_voice", Context.MODE_PRIVATE);
        file = new File(context.getNoBackupFilesDir(), "gleam_voice_snapshot_v2");
        File staged = new File(context.getNoBackupFilesDir(), "gleam_voice_snapshot_v2.pending");
        persistence = new GleamCredentialPersistence(new GleamCredentialPersistence.Storage() {
            public void stage(byte[] encrypted) throws Exception {
                try (FileOutputStream stream = new FileOutputStream(staged)) {
                    stream.write(encrypted); stream.flush(); stream.getFD().sync();
                }
            }
            public byte[] readStaged() throws Exception { return readFile(staged); }
            public void publish() throws Exception {
                // Both files are in one private directory/filesystem. Unlike AtomicFile.finishWrite,
                // this syscall throws on rename failure instead of logging it and returning success.
                Os.rename(staged.getPath(), file.getPath());
            }
            public void discard() { staged.delete(); }
        });
    }
    public String revision() {
        synchronized (GleamCredentialLock.LOCK) {
            String current = mainRevision();
            if (observedMainRevision == null) observedMainRevision = current;
            else if (!observedMainRevision.equals(current)) { observedMainRevision = current; revision = UUID.randomUUID().toString(); }
            return revision;
        }
    }
    public String mainRevision() { return GleamSecretsPlugin.mainRevision(context); }
    public String mainKey() throws Exception { return GleamSecretsPlugin.readMainForNative(context); }
    public String independentKey() throws Exception {
        synchronized (GleamCredentialLock.LOCK) {
            Snapshot value = loadSnapshot();
            return value == null || !"separate".equals(value.source) ? null : decrypt(value.payload);
        }
    }
    boolean hasKey() { synchronized (GleamCredentialLock.LOCK) { try { return GleamSpeechTransport.validKey(readForNativeTransport()); } catch (Exception ignored) { return false; } } }
    String source() { synchronized (GleamCredentialLock.LOCK) { try { Snapshot value = loadSnapshot(); return value == null ? "separate" : value.source; } catch (Exception ignored) { return "separate"; } } }
    String maskedKey() { synchronized (GleamCredentialLock.LOCK) { try { return GleamSpeechCandidateGate.mask(readForNativeTransport()); } catch (Exception ignored) { return ""; } } }
    String maskedMainKey() { synchronized (GleamCredentialLock.LOCK) { try { return GleamSpeechCandidateGate.mask(mainKey()); } catch (Exception ignored) { return ""; } } }
    boolean hasMainKey() { synchronized (GleamCredentialLock.LOCK) { try { return GleamSpeechTransport.validKey(mainKey()); } catch (Exception ignored) { return false; } } }
    GleamSpeechCandidateGate.Config activeConfig() { synchronized (GleamCredentialLock.LOCK) { try { Snapshot value = loadSnapshot(); return value == null ? null : value.config; } catch (Exception ignored) { return null; } } }
    boolean matchesConfig(GleamSpeechCandidateGate.Config config) { GleamSpeechCandidateGate.Config bound = activeConfig(); return bound == null || bound.equals(config); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        return generator.generateKey();
    }
    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] plaintext = value.getBytes(StandardCharsets.UTF_8), encrypted;
        try { encrypted = cipher.doFinal(plaintext); } finally { java.util.Arrays.fill(plaintext, (byte) 0); }
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(encrypted, Base64.NO_WRAP);
    }
    private String decrypt(String payload) throws Exception {
        String[] parts = payload.split("\\.", 2); if (parts.length != 2) throw new IllegalStateException("SPEECH_KEY_STORAGE");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        byte[] plaintext = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
        try { return new String(plaintext, StandardCharsets.UTF_8); } finally { java.util.Arrays.fill(plaintext, (byte) 0); }
    }
    private Snapshot loadSnapshot() throws Exception {
        if (loaded) return snapshot;
        if (file.exists()) {
            byte[] stored = readFile(file);
            JSONObject value = new JSONObject(decrypt(new String(stored, StandardCharsets.UTF_8)));
            String source = value.getString("source");
            if (!"shared".equals(source) && !"separate".equals(source)) throw new IllegalStateException("SPEECH_KEY_STORAGE");
            JSONObject config = value.getJSONObject("config");
            GleamSpeechCandidateGate.Config bound = new GleamSpeechCandidateGate.Config(config.getString("region"), config.getString("workspace"), config.getString("model"));
            bound.validate();
            snapshot = new Snapshot(value.getString("payload"), source, value.getString("mainRevision"), bound);
        } else {
            // Migration is read-only. Existing independently entered voice keys never silently become shared.
            String payload = legacy.getString(SECRET_NAME, null);
            if (payload != null) snapshot = new Snapshot(payload, "separate", "", null);
        }
        loaded = true; return snapshot;
    }
    public GleamSpeechCandidateGate.Receipt commit(String value, String source, String mainRevision, GleamSpeechCandidateGate.Config config) throws Exception {
        synchronized (GleamCredentialLock.LOCK) {
            if (!GleamSpeechTransport.validKey(value) || (!"shared".equals(source) && !"separate".equals(source))) throw new IllegalStateException("SPEECH_CONFIG_INVALID");
            config.validate();
            if (!mainRevision().equals(mainRevision)) throw new IllegalStateException("SPEECH_KEY_CHANGED");
            Snapshot next = new Snapshot(encrypt(value), source, mainRevision, config);
            JSONObject destination = new JSONObject().put("region", config.region).put("workspace", config.workspace).put("model", config.model);
            String record = encrypt(new JSONObject().put("payload", next.payload).put("source", source).put("mainRevision", mainRevision).put("config", destination).toString());
            byte[] bytes = record.getBytes(StandardCharsets.UTF_8);
            String nextRevision = UUID.randomUUID().toString();
            // Prepare the complete safe acknowledgment before the commit point. A transient Keystore
            // read after publication must not make JS believe a successfully saved key was not saved.
            String currentMainKey = mainKey();
            GleamSpeechCandidateGate.Receipt receipt = new GleamSpeechCandidateGate.Receipt(nextRevision, mainRevision, source,
                GleamSpeechCandidateGate.mask(value), GleamSpeechCandidateGate.mask(currentMainKey), GleamSpeechTransport.validKey(currentMainKey), config);
            try { persistence.replace(bytes); }
            finally { java.util.Arrays.fill(bytes, (byte) 0); }
            // Publication returned successfully. No additional verification may turn a committed
            // snapshot into a reported failure; publish all in-memory metadata without further IO.
            snapshot = next; loaded = true; revision = nextRevision;
            // Cleanup cannot roll back or invalidate an already durable v2 snapshot.
            try { legacy.edit().remove(SECRET_NAME).commit(); } catch (RuntimeException ignored) {}
            return receipt;
        }
    }
    private static byte[] readFile(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            for (int count; (count = input.read(buffer)) != -1;) {
                if (output.size() + count > 65536) throw new IllegalStateException("SPEECH_KEY_STORAGE");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }
    String readForNativeTransport() throws Exception {
        synchronized (GleamCredentialLock.LOCK) {
            Snapshot value = loadSnapshot();
            if (value == null) return null;
            if ("shared".equals(value.source) && !value.mainRevision.equals(mainRevision())) return null;
            return decrypt(value.payload);
        }
    }
}
