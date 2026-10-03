package com.gleam.shiguang;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Write-only Capacitor surface. Plaintext is read only by the fixed native Bailian transport. */
final class GleamSpeechCredentials {
    static final String SECRET_NAME = "voice.bailian.apiKey";
    private static final String KEY_ALIAS = "gleam_voice_bailian_v1";
    private final SharedPreferences preferences;
    private boolean blocked;
    private String revision = UUID.randomUUID().toString();
    GleamSpeechCredentials(Context context) { preferences = context.getSharedPreferences("gleam_secure_voice", Context.MODE_PRIVATE); }
    synchronized String revision() { return revision; }
    synchronized boolean hasKey() { return !blocked && preferences.contains(SECRET_NAME); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        return generator.generateKey();
    }
    synchronized void set(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] plaintext = value.getBytes(StandardCharsets.UTF_8);
        byte[] encrypted;
        try { encrypted = cipher.doFinal(plaintext); } finally { java.util.Arrays.fill(plaintext, (byte) 0); }
        String payload = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        if (!preferences.edit().putString(SECRET_NAME, payload).commit()) throw new IllegalStateException("SPEECH_KEY_STORAGE");
        blocked = false;
        revision = UUID.randomUUID().toString();
    }
    synchronized void clear() throws Exception {
        // Invalidate pending starts even if disk removal reports failure.
        blocked = true;
        revision = UUID.randomUUID().toString();
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS);
        if (!preferences.edit().remove(SECRET_NAME).commit()) throw new IllegalStateException("SPEECH_KEY_STORAGE");
    }
    synchronized String readForNativeTransport() throws Exception {
        if (blocked) return null;
        String payload = preferences.getString(SECRET_NAME, null); if (payload == null) return null;
        String[] parts = payload.split("\\.", 2); if (parts.length != 2) throw new IllegalStateException("SPEECH_KEY_STORAGE");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        byte[] plaintext = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
        try { return new String(plaintext, StandardCharsets.UTF_8); } finally { java.util.Arrays.fill(plaintext, (byte) 0); }
    }
}
