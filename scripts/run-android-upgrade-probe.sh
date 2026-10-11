#!/usr/bin/env bash
set -euo pipefail
OUT="$PWD/.tmp/android-upgrade-probe"
mkdir -p "$OUT"
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
emulator -avd gleam_upgrade_probe -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader -accel on -cores 2 -memory 2048 -camera-back none -camera-front none >"$OUT/emulator.log" 2>&1 &
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
cd app/android
./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.gleam.shiguang.UpgradeWebViewProbeTest
