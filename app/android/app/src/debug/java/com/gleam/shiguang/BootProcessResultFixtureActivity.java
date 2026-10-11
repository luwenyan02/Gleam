package com.gleam.shiguang;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Log;
import android.widget.TextView;

/** Separate debug process stays foreground while adb kills the background host process. */
public class BootProcessResultFixtureActivity extends Activity {
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        TextView label = new TextView(this);
        label.setText("Synthetic pending process-restoration result. Returns automatically in 60 seconds.");
        setContentView(label);
        Log.i("BootProcessProbe", "separate result process foreground pid=" + Process.myPid());
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (!isFinishing()) {
                setResult(RESULT_OK, new Intent().putExtra("synthetic", "actual-process-result"));
                finish();
            }
        }, 60_000);
    }
}
