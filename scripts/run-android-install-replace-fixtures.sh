#!/usr/bin/env bash
set -euo pipefail
# Parent owns SDK setup/emulator lifecycle. No install dependencies, downgrade, clear or uninstall.
[ "$#" = 5 ] || { echo 'Usage: bash run-android-install-replace-fixtures.sh OLD_APK CURRENT_APK TEST_APK EMULATOR_SERIAL EVIDENCE_DIR' >&2; exit 2; }
OLD="$1"; CURRENT="$2"; TEST="$3"; SERIAL="$4"; OUT="$5"
for file in "$OLD" "$CURRENT" "$TEST"; do test -s "$file"; done
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
test -n "$SDK"
AAPT="$(find "$SDK/build-tools" -mindepth 2 -maxdepth 2 -name aapt -type f | sort -V | tail -1)"
APKSIGNER="$(find "$SDK/build-tools" -mindepth 2 -maxdepth 2 -name apksigner -type f | sort -V | tail -1)"
test -x "$AAPT" && test -x "$APKSIGNER"
BUILD="$(dirname "$(realpath "$OLD")")"
[ "$(dirname "$(realpath "$CURRENT")")" = "$BUILD" ] && [ "$(dirname "$(realpath "$TEST")")" = "$BUILD" ]
[ "$(basename "$OLD")" = old-debug.apk ] && [ "$(basename "$CURRENT")" = current-debug.apk ] && [ "$(basename "$TEST")" = test-debug.apk ]
(cd "$BUILD" && sha256sum --check stage-artifacts.sha256)
mkdir -p "$OUT"
for stage in old current test; do
  "$AAPT" dump badging "$BUILD/$stage-debug.apk" >"$OUT/$stage-badging.txt"
  "$APKSIGNER" verify --print-certs "$BUILD/$stage-debug.apk" >"$OUT/$stage-signer.txt"
done
"$AAPT" dump xmltree "$BUILD/test-debug.apk" AndroidManifest.xml >"$OUT/test-manifest.txt"
python3 - "$BUILD" "$OUT" <<'PY'
import json, pathlib, re, sys
build, out = map(pathlib.Path, sys.argv[1:]); facts = json.loads((build/'scope.json').read_text())
def fixture_signer(text):
    digests = re.findall(r'^(?:Signer #\d+|V2 Signer:) certificate SHA-256 digest: ([0-9a-fA-F]{64})$', text, re.MULTILINE)
    assert digests and len(digests) == text.count('certificate SHA-256 digest:'), 'Unrecognized certificate output'
    unique = {digest.lower() for digest in digests}
    assert len(unique) == 1, 'Expected one unique fixture signing certificate'
    return unique.pop()
assert facts['source_fixture_sha256'] == 'c6411b17b13e9cd495662f88a607dfbd848c2c06d7c3713f2c5b5c96b16c996e'
for stage in ('old','current','test'):
    signer = fixture_signer((out/f'{stage}-signer.txt').read_text())
    assert signer == facts['debug_signer_sha256'], f'Unexpected paired signer: {stage}'
for stage in ('old','current'):
    text = (out/f'{stage}-badging.txt').read_text()
    match = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", text)
    assert match and 'application-debuggable' in text, f'Unexpected non-debug package: {stage}'
    assert [match.group(1),int(match.group(2)),match.group(3)] == facts[stage]
assert facts['old'] == ['com.gleam.shiguang',11005,'1.10.5']
assert facts['current'][0] == 'com.gleam.shiguang' and facts['current'][1] > 11005
assert re.search(r"package: name='com\.gleam\.shiguang\.test'", (out/'test-badging.txt').read_text())
assert 'application-debuggable' in (out/'test-badging.txt').read_text(), 'Non-debug instrumentation APK refused'
xml = (out/'test-manifest.txt').read_text().splitlines()
blocks = []
for i, line in enumerate(xml):
    if re.match(r'\s*E: instrumentation\b', line):
        indent = len(line) - len(line.lstrip())
        end = i + 1
        while end < len(xml) and len(xml[end]) - len(xml[end].lstrip()) > indent:
            end += 1
        blocks.append('\n'.join(xml[i+1:end]))
assert len(blocks) == 1, 'Expected one instrumentation declaration'
for name, expected in [('name','androidx.test.runner.AndroidJUnitRunner'), ('targetPackage','com.gleam.shiguang')]:
    values = re.findall(r'A: android:' + name + r'\([^)]*\)="([^"]+)"', blocks[0])
    assert values == [expected], f'Unexpected instrumentation {name}: {values}'
PY
case "$SERIAL" in emulator-*) ;; *) echo 'Refusing a non-emulator device serial' >&2; exit 2 ;; esac
[ "${GLEAM_FRESH_AVD:-}" = true ] || { echo 'Parent must confirm a newly provisioned disposable AVD with GLEAM_FRESH_AVD=true' >&2; exit 2; }
[ "$(adb -s "$SERIAL" shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || { echo 'Requires a disposable emulator' >&2; exit 2; }
[ "$(adb -s "$SERIAL" shell getprop ro.build.version.sdk | tr -d '\r')" = 35 ] || { echo 'This bounded harness requires the approved API35 image' >&2; exit 2; }
[ "$(adb -s "$SERIAL" shell am get-current-user | tr -d '\r')" = 0 ]
adb -s "$SERIAL" shell pm list users >"$OUT/users.txt"
[ "$(grep -c 'UserInfo{' "$OUT/users.txt")" = 1 ]
[ -z "$(adb -s "$SERIAL" shell pm list packages -u --user 0 com.gleam.shiguang | tr -d '\r')" ] || { echo 'Found an installed/retained old package profile; never clears it' >&2; exit 2; }
[ -z "$(adb -s "$SERIAL" shell pm path com.gleam.shiguang | tr -d '\r')" ] || { echo 'Requires a fresh emulator package profile; never clears or uninstalls an existing app' >&2; exit 2; }
[ -z "$(adb -s "$SERIAL" shell pm path com.gleam.shiguang.test | tr -d '\r')" ] || { echo 'Requires a fresh test package profile' >&2; exit 2; }
adb -s "$SERIAL" shell dumpsys webviewupdate >"$OUT/webview-provider.txt"
adb -s "$SERIAL" install "$OLD" | tee "$OUT/install-old.txt"
adb -s "$SERIAL" install "$TEST" | tee "$OUT/install-test.txt"
adb -s "$SERIAL" shell dumpsys package com.gleam.shiguang | grep -E 'versionCode=|versionName=' >"$OUT/old-package.txt"
adb -s "$SERIAL" shell am instrument -w -r -e gleamEphemeralFixture true -e class com.gleam.shiguang.GleamInstallReplaceSeedTest com.gleam.shiguang.test/androidx.test.runner.AndroidJUnitRunner | tee "$OUT/seed.txt"
grep -F 'OK (1 test)' "$OUT/seed.txt"
! grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED' "$OUT/seed.txt"
adb -s "$SERIAL" shell am force-stop com.gleam.shiguang
# The tested boundary: replace the same package/signature, keeping its complete data profile.
adb -s "$SERIAL" install -r "$CURRENT" | tee "$OUT/install-replace.txt"
adb -s "$SERIAL" shell dumpsys package com.gleam.shiguang | grep -E 'versionCode=|versionName=' >"$OUT/current-package.txt"
adb -s "$SERIAL" shell am instrument -w -r -e gleamEphemeralFixture true -e class com.gleam.shiguang.GleamInstallReplaceVerifyTest com.gleam.shiguang.test/androidx.test.runner.AndroidJUnitRunner | tee "$OUT/verify.txt"
grep -F 'OK (1 test)' "$OUT/verify.txt"
! grep -E 'FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED' "$OUT/verify.txt"
adb -s "$SERIAL" logcat -d -s GleamInstallReplace:I AndroidRuntime:E '*:S' >"$OUT/stage-logcat.txt"
echo 'Debug install-replace harness passed; current application/test APKs remain installed for the parent suite.'
