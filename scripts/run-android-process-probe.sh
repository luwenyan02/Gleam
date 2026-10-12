#!/usr/bin/env bash
set -euo pipefail
OUT="$PWD/.tmp/android-upgrade-probe"
mkdir -p "$OUT"
exec > >(tee "$OUT/process-death-stage.txt") 2>&1
PACKAGE=com.gleam.shiguang
ad() { adb -s emulator-5554 "$@"; }
report() { ad shell run-as "$PACKAGE" cat shared_prefs/gleam_boot_process_probe.xml 2>/dev/null || true; }
ad shell am force-stop "$PACKAGE"
ad shell am start -W -n "$PACKAGE/.BootProcessRestorationFixtureActivity" --ez armSyntheticProcessDeath true
for i in $(seq 1 80); do
  REPORT=$(report)
  if grep -q 'name="state_saved" value="true"' <<<"$REPORT"; then break; fi
  sleep 0.25
done
grep -q 'name="state_saved" value="true"' <<<"$REPORT"
FOREGROUND=$(ad shell dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity')
printf '%s\n' "$FOREGROUND"
grep -q 'BootProcessResultFixtureActivity' <<<"$FOREGROUND"
ORIGINAL_PID=$(ad shell pidof "$PACKAGE" | tr -d '\r')
RESULT_PID=$(ad shell pidof "$PACKAGE:boot_result" | tr -d '\r')
[[ "$ORIGINAL_PID" =~ ^[0-9]+$ && "$RESULT_PID" =~ ^[0-9]+$ && "$ORIGINAL_PID" != "$RESULT_PID" ]]
printf 'original_pid=%s result_pid=%s\n' "$ORIGINAL_PID" "$RESULT_PID"
printf 'Killing only synthetic background main process via run-as: %s\n' "$ORIGINAL_PID"
ad shell run-as "$PACKAGE" kill -9 "$ORIGINAL_PID"
for i in $(seq 1 20); do
  ALIVE=$(ad shell pidof "$PACKAGE" | tr -d '\r' || true)
  [ "$ALIVE" != "$ORIGINAL_PID" ] && break
  sleep 0.1
done
[ "$ALIVE" != "$ORIGINAL_PID" ]
[ "$(ad shell pidof "$PACKAGE:boot_result" | tr -d '\r')" = "$RESULT_PID" ]
echo 'Original process gone; separate foreground result producer survived.'
for i in $(seq 1 100); do
  REPORT=$(report)
  if grep -q 'name="completed" value="true"' <<<"$REPORT"; then break; fi
  sleep 1
done
printf '%s\n' "$REPORT" > "$OUT/process-death-report.xml"
ad logcat -d -s BootProcessProbe:I '*:S' > "$OUT/process-death-logcat.txt"
grep -q 'name="completed" value="true"' <<<"$REPORT"
ad shell am instrument -w -r -e class com.gleam.shiguang.GleamProcessDeathResultVerificationTest -e expected_original_pid "$ORIGINAL_PID" "$PACKAGE.test/androidx.test.runner.AndroidJUnitRunner" | tee "$OUT/process-death-verification.txt"
grep -F 'OK (1 test)' "$OUT/process-death-verification.txt"
! grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED' "$OUT/process-death-verification.txt"
