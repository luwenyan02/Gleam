package com.gleam.shiguang;

import android.content.SharedPreferences;
import android.os.Bundle;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Run ONLY after the explicit adb process-death stages, not with the default first suite. */
@androidx.test.filters.SdkSuppress(minSdkVersion = 26)
@RunWith(AndroidJUnit4.class)
public class GleamProcessDeathResultVerificationTest {
    @Test public void verifyActualProcessDeathPendingActivityResult() {
        String expected = InstrumentationRegistry.getArguments().getString("expected_original_pid");
        org.junit.Assume.assumeTrue("separate adb process-death stage was not requested", expected != null);
        SharedPreferences report = BootProcessRestorationFixtureActivity.proof(
            InstrumentationRegistry.getInstrumentation().getTargetContext());
        assertTrue("run explicit process-death setup first", report.getBoolean("armed", false));
        assertTrue("actual pending AndroidX/Capacitor state was never saved", report.getBoolean("state_saved", false));
        assertTrue("result stage not complete", report.getBoolean("completed", false));
        int original = report.getInt("original_pid", -1);
        int restored = report.getInt("restored_pid", -1);
        assertTrue(original > 0 && restored > 0);
        assertNotEquals("Activity recreation is insufficient; process PID must change", original, restored);
        assertNotNull("pass the PID actually killed by adb", expected);
        assertEquals(Integer.parseInt(expected), original);
        assertEquals(restored, report.getInt("callback_pid", -2));
        assertTrue(report.getBoolean("saved_bundle_present", false));
        assertTrue(report.getBoolean("plugin_restored_before_oncreate_return", false));
        assertTrue(report.getBoolean("native_state_preserved", false));
        assertTrue(report.getBoolean("options_preserved", false));
        assertTrue(report.getBoolean("activity_call_retained", false));
        assertTrue(report.getBoolean("dangling_restored_call", false));
        assertTrue(report.getBoolean("gate_closed_at_result", false));
        assertTrue(report.getBoolean("result_ok", false));
        assertEquals("actual activity result must be delivered exactly once", 1, report.getInt("activity_callbacks", 0));
        assertEquals("native App restored event must be retained/delivered exactly once", 1, report.getInt("app_restored_events", 0));
        assertTrue(report.getBoolean("app_payload_preserved", false));
        Bundle status = new Bundle();
        status.putString("restoration_kind", "actual_background_app_process_killed_with_foreground_result_process_retained");
        status.putInt("original_pid", original);
        status.putInt("restored_pid", restored);
        InstrumentationRegistry.getInstrumentation().sendStatus(0, status);
    }
}
