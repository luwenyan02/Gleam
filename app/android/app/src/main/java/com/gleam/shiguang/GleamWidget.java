package com.gleam.shiguang;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** 桌面只读缓存。过期周期不继续展示旧金额，点击入口进入应用重新计算。 */
public final class GleamWidget extends AppWidgetProvider {
    static final String CACHE = "gleam_widget_summary";

    static boolean isCurrentPeriod(long now, long from, long to) {
        return from > 0 && to > from && now >= from && now < to;
    }

    static boolean useWideLayout(int minimumWidth) { return minimumWidth >= 250; }

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) render(context, manager, id);
    }

    @Override public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int id, Bundle options) {
        render(context, manager, id);
    }

    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        for (int id : manager.getAppWidgetIds(new ComponentName(context, GleamWidget.class))) render(context, manager, id);
    }

    private static void render(Context context, AppWidgetManager manager, int id) {
        SharedPreferences cache = context.getSharedPreferences(CACHE, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long from = cache.getLong("from", 0), to = cache.getLong("to", 0);
        boolean current = isCurrentPeriod(now, from, to);
        boolean hidden = cache.getBoolean("private", false);
        Bundle options = manager.getAppWidgetOptions(id);
        boolean wide = useWideLayout(options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0));
        RemoteViews views = new RemoteViews(context.getPackageName(), wide ? R.layout.gleam_widget_wide : R.layout.gleam_widget);
        views.setTextViewText(R.id.widget_expense, current ? cache.getString("expense", "—") : "—");
        views.setTextViewText(R.id.widget_remaining, current ? cache.getString("remaining", "—") : "—");
        String caption = "打开拾光更新本月";
        if (current) {
            SimpleDateFormat range = new SimpleDateFormat("M/d", Locale.CHINA);
            SimpleDateFormat time = new SimpleDateFormat("M/d HH:mm", Locale.CHINA);
            caption = hidden ? "已隐藏金额 · 打开应用解锁" : range.format(new Date(from)) + "–" + range.format(new Date(to - 1))
                + " · " + time.format(new Date(cache.getLong("updatedAt", 0))) + " 更新";
        }
        views.setTextViewText(R.id.widget_caption, caption);
        Intent intent = new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse("shiguang://entry?type=expense"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(context, 7101, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_add, pending);
        views.setOnClickPendingIntent(R.id.widget_root, pending);
        manager.updateAppWidget(id, views);
    }
}
