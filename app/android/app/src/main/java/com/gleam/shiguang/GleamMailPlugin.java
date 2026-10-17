package com.gleam.shiguang;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.mail.AuthenticationFailedException;

@CapacitorPlugin(name = "GleamMail")
public final class GleamMailPlugin extends Plugin {
    private static final AtomicBoolean BUSY = new AtomicBoolean();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod public void test(PluginCall call) { submit(call, false); }
    @PluginMethod public void send(PluginCall call) { submit(call, true); }

    private void submit(PluginCall call, boolean sending) {
        if (!BUSY.compareAndSet(false, true)) { call.reject("正在处理邮箱请求", "BUSY"); return; }
        try { executor.execute(() -> {
            try {
                String username = call.getString("username"), recipient = call.getString("recipient"), code = call.getString("authCode");
                GleamMailSender.validate(username, recipient, code);
                if (!sending) {
                    GleamMailSender.execute(username, recipient, code, null, null);
                    call.resolve(); return;
                }
                String name = call.getString("fileName"), encoded = call.getString("contentBase64"), id = call.getString("requestId");
                if (encoded == null || encoded.length() > ((GleamMailSender.MAX_BYTES + 2) / 3) * 4) throw new IllegalArgumentException("INVALID");
                byte[] content = Base64.decode(encoded, Base64.NO_WRAP);
                GleamMailSender.validateAttachment(name, content);
                MessageDigest hash = MessageDigest.getInstance("SHA-256");
                hash.update((username + "\0" + recipient + "\0" + name + "\0").getBytes(StandardCharsets.UTF_8));
                String digest = Base64.encodeToString(hash.digest(content), Base64.NO_WRAP);
                SharedPreferences prefs = getContext().getSharedPreferences("gleam_mail_requests", Context.MODE_PRIVATE);
                GleamMailLedger ledger = new GleamMailLedger(new GleamMailLedger.Store() {
                    public String get(String key) { return prefs.getString(key, null); }
                    public void put(String key, String value) throws Exception {
                        if (!prefs.edit().putString(key, value).commit()) throw new java.io.IOException("storage");
                    }
                });
                ledger.send(id, digest, () -> GleamMailSender.execute(username, recipient, code, name, content));
                JSObject result = new JSObject(); result.put("status", "accepted"); call.resolve(result);
            } catch (AuthenticationFailedException error) {
                call.reject("QQ 邮箱验证失败", "AUTH");
            } catch (IllegalArgumentException error) {
                call.reject("邮箱配置或附件无效", "INVALID");
            } catch (Exception error) {
                call.reject(sending ? "发送结果未确认，请先检查收件箱" : "QQ 邮箱连接失败", sending ? "UNCERTAIN" : "NETWORK");
            } finally { BUSY.set(false); }
        }); } catch (java.util.concurrent.RejectedExecutionException error) {
            BUSY.set(false);
            call.reject("邮箱页面已关闭，请重新打开后重试", "NETWORK");
        }
    }

    @Override protected void handleOnDestroy() {
        executor.shutdown(); // Allow a user-confirmed in-flight send to finish, with socket timeouts.
        super.handleOnDestroy();
    }
}
