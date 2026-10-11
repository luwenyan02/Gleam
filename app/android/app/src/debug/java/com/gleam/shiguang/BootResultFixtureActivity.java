package com.gleam.shiguang;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.TextView;

/** Real Android activity result producer, with no permissions, files or external service. */
public class BootResultFixtureActivity extends Activity {
    public static volatile BootResultFixtureActivity latest;
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        latest = this;
        TextView label = new TextView(this);
        label.setText("Synthetic boot lifecycle result fixture");
        setContentView(label);
    }
    public void finishSyntheticResult() {
        setResult(RESULT_OK, new Intent().putExtra("synthetic", "preserved-result"));
        finish();
    }
    @Override protected void onDestroy() {
        if (latest == this) latest = null;
        super.onDestroy();
    }
}
