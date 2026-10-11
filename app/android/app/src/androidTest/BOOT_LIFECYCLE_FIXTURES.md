# Synthetic native boot fixture stages

Use only a fresh ephemeral emulator, never a user-installed app or device. No fixture component,
plugin, network fence, report, or extra process exists in release. The debug manifest adds no
permissions. Tests require API 26+; the current targeted emulator is API 35/WebView 124.

## First suite

After building/syncing current app assets with the existing project workflow:

```
cd app/android
./gradlew :app:connectedDebugAndroidTest \
  '-Pandroid.testInstrumentationRunnerArguments.class=com.gleam.shiguang.GleamBootWebViewInstrumentationTest,com.gleam.shiguang.GleamNativeBootLifecycleTest,com.gleam.shiguang.GleamPermissionRestorationProbeTest,com.gleam.shiguang.GleamNativeBootUpgradeIntegrationTest'
```

These are seven tests: isolated closed WebView construction; four actual MainActivity/AndroidX
lifecycle tests; one diagnostic pending-permission comparison; one production-gate owned-worker
upgrade integration. `UpgradeWebViewProbeTest` is a separate primitive invocation on the same
emulator, not part of this count. Do not clear app data between the invocations merely to pass.

The ordinary lifecycle recreation tests call Android Activity recreation, not process death.
The real pending Activity-result test opens a real synthetic result Activity and recreates its
background host before returning its OS result. Native plugin state/options and App's retained
restored-result event must survive exactly once while the new main WebView is still closed.

Timeout/stale-generation callbacks are accelerated synthetic injections into the exact production
callback paths. The permission diagnostic seeds a raw pending result into the real AndroidX
registry without a permission request. It compares an ordinary ungated CapacitorWebView/Bridge
host against MainActivity and explicitly reports callback call retention. Current Capacitor saves
activity calls but does not persist its permission-call queue; null in both hosts is a documented
inherited limitation, NOT full permission restoration acceptance. There is no microphone or system
permission dialog, grant, revoke, or security-setting operation.

Network-sensitive native adapters (`CapacitorHttp`, `GleamWebDav`, `GleamSpeech`) are replaced
only in fixture hosts with rejecting debug adapters. The generated config is loaded intact and
only CapacitorHttp.enabled is disabled before Bridge initialization. This preserves actual main
boot/AndroidX/result/plugin restoration lifecycle but does NOT exercise live HTTP/WebDAV/speech
provider implementations. Both local HTTP interceptor paths are denied before the local server
can proxy them. There are no real provider calls or microphone requests.

The debug-only network fence delegates actual Bridge page/error/render callbacks, serves only
HTTPS localhost requests through the local asset server, returns 403 for all others, and never
falls back to networking. It replaces SW routing only after the production gate has opened; the
production pre-open interceptor remains under test. Quarantine observation delegates all production
callbacks, never attaches a bridge, and adds only a read-only native evaluateJavascript query.

## Separate actual process-death stage

Build/install the same debug APK and androidTest APK through the already authorized emulator CI
workflow. Run these commands outside an instrumentation invocation. The fixture result Activity
runs in `:boot_result` and returns after 60 seconds. The main app process must be killed only after
pending native/AndroidX state is saved and while that separate result process is foreground.

```
PACKAGE=com.gleam.shiguang
adb shell am force-stop "$PACKAGE"
adb shell am start -W -n "$PACKAGE/.BootProcessRestorationFixtureActivity" \
  --ez armSyntheticProcessDeath true

# Poll until the exact synthetic saved-state marker appears (normally under a few seconds).
# Also verify dumpsys activity activities shows BootProcessResultFixtureActivity as resumed.
for i in $(seq 1 80); do
  REPORT=$(adb shell run-as "$PACKAGE" cat shared_prefs/gleam_boot_process_probe.xml 2>/dev/null || true)
  echo "$REPORT" | grep -q 'name="state_saved" value="true"' && break
  sleep 0.25
done
echo "$REPORT" | grep -q 'name="state_saved" value="true"' || exit 1
adb shell dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'
ORIGINAL_PID=$(adb shell pidof "$PACKAGE" | tr -d '\r')
RESULT_PID=$(adb shell pidof "$PACKAGE:boot_result" | tr -d '\r')
[ -n "$ORIGINAL_PID" ] && [ -n "$RESULT_PID" ] && [ "$ORIGINAL_PID" != "$RESULT_PID" ] || exit 1

# run-as is supported by this debug APK. Kill ONLY the background main process, not force-stop.
adb shell run-as "$PACKAGE" kill -9 "$ORIGINAL_PID"
# Verify kill took effect and the separate foreground producer survived.
! adb shell pidof "$PACKAGE" | tr -d '\r' | grep -qx "$ORIGINAL_PID" || exit 1
[ "$(adb shell pidof "$PACKAGE:boot_result" | tr -d '\r')" = "$RESULT_PID" ] || exit 1

# Wait for the real OS result to restore the dead host process and retain App's native event.
for i in $(seq 1 100); do
  REPORT=$(adb shell run-as "$PACKAGE" cat shared_prefs/gleam_boot_process_probe.xml 2>/dev/null || true)
  echo "$REPORT" | grep -q 'name="completed" value="true"' && break
  sleep 1
done
echo "$REPORT" | grep -q 'name="completed" value="true"' || exit 1
adb logcat -d -s BootProcessProbe:I '*:S'
adb shell am instrument -w -r \
  -e class com.gleam.shiguang.GleamProcessDeathResultVerificationTest \
  -e expected_original_pid "$ORIGINAL_PID" \
  "$PACKAGE.test/androidx.test.runner.AndroidJUnitRunner"
```

Keep `ORIGINAL_PID`, `RESULT_PID`, exact kill command/status, foreground Activity evidence, logcat,
synthetic report, and instrumentation result together. The verifier requires different original and
restored PIDs, the killed original PID, actual AndroidX callback PID matching the restored host,
original saved Bundle/native plugin state/options, dangling restored call, closed main gate at
callback, exactly one Activity callback, exactly one native App restored event, and intact payload.
A passed verifier without the external kill evidence is insufficient to claim actual process death.

Do not replace the kill step with force-stop: force-stop cancels the task/result and tests a different
flow. Do not run any permission requests or live provider calls. The verification-only test skips in
ordinary runs lacking `expected_original_pid`, and must not be presented as covered by the first
suite. No automated stage has been executed in the local workspace: only Java syntax was parsed;
Android type compilation and emulator execution are pending the parent's existing CI.
