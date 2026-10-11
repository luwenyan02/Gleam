#!/usr/bin/env bash
set -euo pipefail
OUT="$PWD/.tmp/android-upgrade-probe"
mkdir -p "$OUT"
APP_APK="$PWD/app/android/app/build/outputs/apk/debug/app-debug.apk"
TEST_APK="$PWD/app/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
test -s "$APP_APK" && test -s "$TEST_APK"
# Only this job's reproducible npm install is discarded after both APKs are built.
python3 -c 'import shutil; shutil.rmtree("app/node_modules")'

export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export ANDROID_USER_HOME="$RUNNER_TEMP/gleam-probe-android"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
mkdir -p "$ANDROID_AVD_HOME"
test -r /dev/kvm && test -w /dev/kvm
emulator -accel-check | tee "$OUT/acceleration.txt"
cat "$ANDROID_HOME/emulator/source.properties" | tee "$OUT/emulator-package-version.txt"
printf 'no\n' | avdmanager create avd --name gleam_upgrade_probe --package 'system-images;android-35;google_apis;x86_64' --path "$ANDROID_AVD_HOME/gleam_upgrade_probe.avd" --force
ls -la "$ANDROID_AVD_HOME"
test -s "$ANDROID_AVD_HOME/gleam_upgrade_probe.ini"
emulator -list-avds | tee "$OUT/avd-list.txt"
# The isolated probe needs only a small synthetic ledger, not the default 6 GiB data disk.
python3 - "$ANDROID_AVD_HOME/gleam_upgrade_probe.avd/config.ini" <<'PYCONFIG'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
lines = [line for line in p.read_text().splitlines() if not line.startswith('disk.dataPartition.size=')]
p.write_text('\n'.join(lines + ['disk.dataPartition.size=2G']) + '\n')
PYCONFIG
df -h "$ANDROID_AVD_HOME"
emulator -avd gleam_upgrade_probe -partition-size 2048 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader -accel on -cores 2 -memory 2048 -camera-back none -camera-front none >"$OUT/emulator.log" 2>&1 &
EMULATOR_PID=$!
trap 'adb -s emulator-5554 emu kill >/dev/null 2>&1 || true; kill "$EMULATOR_PID" 2>/dev/null || true' EXIT
booted=false
for attempt in $(seq 1 120); do
  kill -0 "$EMULATOR_PID" || { cat "$OUT/emulator.log"; exit 1; }
  if [ "$(adb -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; then booted=true; break; fi
  sleep 5
done
[ "$booted" = true ] || { echo 'Emulator boot exceeded 600-second observation window'; tail -100 "$OUT/emulator.log"; exit 1; }
adb -s emulator-5554 shell dumpsys webviewupdate > "$OUT/webview-provider.txt"
adb -s emulator-5554 shell input keyevent 82
adb -s emulator-5554 install "$APP_APK"
adb -s emulator-5554 install "$TEST_APK"
adb -s emulator-5554 shell am instrument -w -r -e class com.gleam.shiguang.UpgradeWebViewProbeTest com.gleam.shiguang.test/androidx.test.runner.AndroidJUnitRunner | tee "$OUT/instrumentation.txt"
grep -F 'OK (1 test)' "$OUT/instrumentation.txt"
! grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED' "$OUT/instrumentation.txt"

# Exact old public assets seed before any current app opens its real synthetic schema.
adb -s emulator-5554 shell am instrument -w -r -e gleamEphemeralFixture true -e class com.gleam.shiguang.GleamHistoricalAssetsUpgradeTest com.gleam.shiguang.test/androidx.test.runner.AndroidJUnitRunner | tee "$OUT/historical-assets.txt"
grep -F 'OK (1 test)' "$OUT/historical-assets.txt"
! grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED' "$OUT/historical-assets.txt"

# A fresh instrumentation process exercises real Bridge lifecycle without resetting app data.
adb -s emulator-5554 shell am instrument -w -r -e class com.gleam.shiguang.GleamBootWebViewInstrumentationTest,com.gleam.shiguang.GleamNativeBootLifecycleTest,com.gleam.shiguang.GleamPermissionRestorationProbeTest,com.gleam.shiguang.GleamNativeBootUpgradeIntegrationTest com.gleam.shiguang.test/androidx.test.runner.AndroidJUnitRunner | tee "$OUT/boot-integration.txt"
grep -F 'OK (7 tests)' "$OUT/boot-integration.txt"
! grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED' "$OUT/boot-integration.txt"

bash scripts/run-android-process-probe.sh
