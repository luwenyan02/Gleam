package com.gleam.shiguang;

import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;

/** No caller-supplied URL, redirect, insecure TLS, retries, or credential-bearing diagnostics. */
final class GleamSpeechTransport {
    static final String MODEL = "qwen3.8-omni-flash-realtime";
    static boolean validWorkspace(String workspace) {
        return workspace != null && workspace.matches("[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?");
    }
    static boolean validSessionId(String id) { return id != null && id.matches("[A-Za-z0-9_-]{8,80}"); }
    static boolean validKey(String value) { return value != null && value.matches("[!-~]{8,512}"); }
    static String endpoint(String region, String workspace, String model) {
        if (!validWorkspace(workspace) || !MODEL.equals(model)) throw new IllegalArgumentException("SPEECH_CONFIG_INVALID");
        String suffix;
        if ("beijing".equals(region)) suffix = "cn-beijing";
        else if ("singapore".equals(region)) suffix = "ap-southeast-1";
        else throw new IllegalArgumentException("SPEECH_CONFIG_INVALID");
        return "wss://" + workspace + "." + suffix + ".maas.aliyuncs.com/api-ws/v1/realtime?model=" + MODEL;
    }
    static Request request(String region, String workspace, String model, String key) {
        String endpoint = endpoint(region, workspace, model);
        if (!validKey(key)) throw new IllegalArgumentException("SPEECH_KEY_REQUIRED");
        return new Request.Builder().url(endpoint).header("Authorization", "Bearer " + key).build();
    }
    static OkHttpClient client() {
        return new OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS).pingInterval(10, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build();
    }
    static String statusCode(int status) {
        if (status == 401 || status == 403) return "SPEECH_AUTH";
        if (status == 429) return "SPEECH_RATE_LIMIT";
        return "SPEECH_PROVIDER";
    }
}
