package com.gleam.shiguang;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

@CapacitorPlugin(name = "GleamSecrets")
public class GleamSecretsPlugin extends Plugin {
    private static final String KEY_ALIAS = "gleam_secret_store_v1";
    private static final String PREFS_NAME = "gleam_secure_secrets";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    private static final String MAIN_KEY = "ai.apiKey";
    private static final String MAIN_REVISION = "_gleam.mainKeyRevision";
    private SharedPreferences preferences() { return preferences(getContext()); }
    private static SharedPreferences preferences(Context context) { return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE); }
    /** Native-only sharing. Neither this accessor nor its revision exposes a voice key over the bridge. */
    static String mainRevision(Context context) {
        synchronized (GleamCredentialLock.LOCK) {
            SharedPreferences prefs = preferences(context);
            String payload = prefs.getString(MAIN_KEY, "");
            String revision = prefs.getString(MAIN_REVISION, "");
            return UUID.nameUUIDFromBytes((revision + ":" + payload).getBytes(StandardCharsets.UTF_8)).toString();
        }
    }
    static String readMainForNative(Context context) throws Exception {
        synchronized (GleamCredentialLock.LOCK) {
            String payload = preferences(context).getString(MAIN_KEY, null);
            return payload == null ? null : decrypt(payload);
        }
    }

    private boolean validKey(String key) {
        return key != null && !key.startsWith("voice.bailian.") && !key.startsWith("update.github.") && key.matches("[A-Za-z0-9._-]{1,80}");
    }

    /** Erase credentials from old private-repository updater versions without reading them. */
    static void clearLegacyUpdateToken(Context context) {
        synchronized (GleamCredentialLock.LOCK) {
            if (!preferences(context).edit().remove("update.github.token").commit()) throw new IllegalStateException("storage");
        }
    }

    private static SecretKey encryptionKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    private static String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey());
        byte[] plaintext = value.getBytes(StandardCharsets.UTF_8);
        byte[] encrypted;
        try { encrypted = cipher.doFinal(plaintext); } finally { java.util.Arrays.fill(plaintext, (byte) 0); }
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
            + "."
            + Base64.encodeToString(encrypted, Base64.NO_WRAP);
    }

    private static String decrypt(String payload) throws Exception {
        String[] parts = payload.split("\\.", 2);
        if (parts.length != 2) throw new IllegalArgumentException("invalid payload");
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), new GCMParameterSpec(128, iv));
        byte[] plaintext = cipher.doFinal(encrypted);
        try { return new String(plaintext, StandardCharsets.UTF_8); } finally { java.util.Arrays.fill(plaintext, (byte) 0); }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (!validKey(key)) { call.reject("无效的安全存储键"); return; }
        synchronized (GleamCredentialLock.LOCK) {
            String payload = preferences().getString(key, null);
            JSObject result = new JSObject();
            if (payload == null) { result.put("value", JSONObject.NULL); call.resolve(result); return; }
            try { result.put("value", decrypt(payload)); call.resolve(result); }
            catch (Exception error) {
                SharedPreferences.Editor editor = preferences().edit().remove(key);
                if (MAIN_KEY.equals(key)) editor.putString(MAIN_REVISION, UUID.randomUUID().toString());
                editor.commit();
                if (MAIN_KEY.equals(key)) GleamCredentialLock.changed();
                call.reject("安全凭据已失效，请重新输入");
            }
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key"), value = call.getString("value");
        if (!validKey(key) || value == null) { call.reject("无效的安全存储参数"); return; }
        synchronized (GleamCredentialLock.LOCK) {
            try {
                SharedPreferences.Editor editor = preferences().edit().putString(key, encrypt(value));
                if (MAIN_KEY.equals(key)) editor.putString(MAIN_REVISION, UUID.randomUUID().toString());
                boolean saved = editor.commit();
                if (MAIN_KEY.equals(key)) GleamCredentialLock.changed();
                if (!saved) throw new IllegalStateException("storage");
                call.resolve();
            } catch (Exception error) { call.reject("安全凭据保存失败"); }
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (!validKey(key)) { call.reject("无效的安全存储键"); return; }
        synchronized (GleamCredentialLock.LOCK) {
            SharedPreferences.Editor editor = preferences().edit().remove(key);
            if (MAIN_KEY.equals(key)) editor.putString(MAIN_REVISION, UUID.randomUUID().toString());
            boolean saved = editor.commit();
            if (MAIN_KEY.equals(key)) GleamCredentialLock.changed();
            if (saved) call.resolve(); else call.reject("安全凭据移除失败");
        }
    }
}
