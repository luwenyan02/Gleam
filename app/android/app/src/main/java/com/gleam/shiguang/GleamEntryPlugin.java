package com.gleam.shiguang;

import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** 原生仅维护桌面快捷入口；所有账务操作仍由 Web 数据仓库提交。 */
@CapacitorPlugin(name = "GleamEntry")
public final class GleamEntryPlugin extends Plugin {
    @PluginMethod
    public void updateWidget(PluginCall call) {
        String expense = call.getString("expense", "—");
        String remaining = call.getString("remaining", "—");
        boolean hidden = Boolean.TRUE.equals(call.getBoolean("private", false));
        // 限定为格式化摘要，不接收或持久化账单内容。
        if (expense.length() > 32 || remaining.length() > 32) { call.reject("摘要无效"); return; }
        getContext().getSharedPreferences(GleamWidget.CACHE, android.content.Context.MODE_PRIVATE).edit()
            .putString("expense", hidden ? "••••" : expense)
            .putString("remaining", hidden ? "••••" : remaining)
            .putLong("from", call.getData().optLong("from", 0))
            .putLong("to", call.getData().optLong("to", 0))
            .putLong("updatedAt", call.getData().optLong("updatedAt", 0))
            .putBoolean("private", hidden).apply();
        GleamWidget.refreshAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void setShortcuts(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) { call.resolve(); return; }
        try {
            ShortcutManager manager = getContext().getSystemService(ShortcutManager.class);
            if (manager == null) { call.resolve(); return; }
            List<ShortcutInfo> shortcuts = new ArrayList<>();
            shortcuts.add(shortcut("expense", "记支出", "type=expense", 0));
            shortcuts.add(shortcut("income", "记收入", "type=income", 1));
            JSArray templates = call.getArray("templates", new JSArray());
            int limit = Math.min(4, manager.getMaxShortcutCountPerActivity());
            for (int i = 0; i < templates.length() && shortcuts.size() < limit; i++) {
                JSONObject item = templates.getJSONObject(i);
                long id = item.optLong("id", -1);
                String name = item.optString("name", "速记");
                if (id <= 0 || id > 9007199254740991L) continue;
                if (name.trim().isEmpty()) name = "速记";
                shortcuts.add(shortcut("template-" + id, name, "template=" + id, shortcuts.size()));
            }
            if (!manager.setDynamicShortcuts(shortcuts.subList(0, Math.min(limit, shortcuts.size())))) {
                call.reject("桌面快捷入口更新受系统频率限制"); return;
            }
            call.resolve();
        } catch (Exception error) { call.reject("无法更新桌面快捷入口"); }
    }

    private ShortcutInfo shortcut(String id, String name, String query, int rank) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("shiguang://entry?" + query), getContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return new ShortcutInfo.Builder(getContext(), id)
            .setShortLabel(name).setLongLabel(name).setRank(rank)
            .setIcon(Icon.createWithResource(getContext(), R.mipmap.ic_launcher))
            .setIntent(intent).build();
    }
}
