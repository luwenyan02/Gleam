package com.gleam.shiguang;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(GleamSecretsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
