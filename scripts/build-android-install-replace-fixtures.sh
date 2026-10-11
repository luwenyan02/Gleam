#!/usr/bin/env bash
set -euo pipefail
# Builds two self-built DEBUG harnesses. Historical WEB bytes only; current native code in both.
# Requires the parent's existing npm build + Capacitor sync and installed Android build tools.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/.tmp/android-install-replace-build}"
OUT="$(realpath -m "$OUT")"
case "$OUT" in "$ROOT"/.tmp/*) ;; *) echo 'Output must stay in this checkout .tmp directory' >&2; exit 2 ;; esac
[ "${GLEAM_EPHEMERAL_FIXTURE:-}" = true ] || { echo 'Set GLEAM_EPHEMERAL_FIXTURE=true for disposable debug fixture builds only' >&2; exit 2; }
for name in GLEAM_KEYSTORE_PROPERTIES GLEAM_KEYSTORE_PATH GLEAM_KEYSTORE_PASSWORD GLEAM_KEY_ALIAS GLEAM_KEY_PASSWORD; do
  [ -z "${!name:-}" ] || { echo 'This harness refuses configured release-signing inputs' >&2; exit 2; }
done
[ ! -f "$HOME/Library/Application Support/Gleam/signing/keystore.properties" ] || { echo 'This harness refuses a user release-signing properties file' >&2; exit 2; }
PUBLIC="$ROOT/app/android/app/src/main/assets/public"
test -s "$PUBLIC/index.html"
test -d "$ROOT/app/node_modules/@capacitor/android"
mkdir -p "$OUT" "$ROOT/.tmp"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
test -n "$SDK"
AAPT="$(find "$SDK/build-tools" -mindepth 2 -maxdepth 2 -name aapt -type f | sort -V | tail -1)"
APKSIGNER="$(find "$SDK/build-tools" -mindepth 2 -maxdepth 2 -name apksigner -type f | sort -V | tail -1)"
test -x "$AAPT" && test -x "$APKSIGNER"
WORK="$(mktemp -d "$ROOT/.tmp/install-replace-build.XXXXXX")"
# Share the already-installed dependency cache, but give this build an isolated user home.
# AGP creates its standard debug.keystore here, never reads the user's debug signer.
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
python3 - "$ROOT" "$GRADLE_USER_HOME" <<'PY'
import hashlib, pathlib, re, sys
root, cache = map(pathlib.Path, sys.argv[1:])
properties = (root/'app/android/gradle/wrapper/gradle-wrapper.properties').read_text()
url = re.search(r'^distributionUrl=(.+)$', properties, re.M).group(1).replace('\\:', ':')
match = re.search(r'/(gradle-[\w.]+-(?:all|bin))\.zip$', url)
assert match, 'Unexpected Gradle wrapper distribution'
number = int.from_bytes(hashlib.md5(url.encode()).digest(), 'big')
digits = '0123456789abcdefghijklmnopqrstuvwxyz'; cache_hash = ''
while number:
    number, remainder = divmod(number, 36); cache_hash = digits[remainder] + cache_hash
directory = cache/'wrapper/dists'/match.group(1)/(cache_hash or '0')
assert (directory/(match.group(1)+'.zip.ok')).is_file(), 'Parent must populate the exact URL-specific completed wrapper cache'
assert any(directory.glob('gradle-*/bin/gradle')), 'Missing already-installed wrapper executable for this URL'

PY
FIXTURE_HOME="$WORK/user-home"
export ANDROID_USER_HOME="$FIXTURE_HOME/.android"
mkdir -p "$ANDROID_USER_HOME"
cp -a "$PUBLIC" "$WORK/current-public"
RESTORE_NEEDED=false
restore() {
  if [ "$RESTORE_NEEDED" = true ]; then
    test -s "$WORK/current-public/index.html"
    rm -rf "$PUBLIC"
    cp -a "$WORK/current-public" "$PUBLIC"
    RESTORE_NEEDED=false
  fi
}
trap restore EXIT
trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM
cd "$ROOT"
python3 - "$WORK/old-public" <<'PY'
import pathlib, sys
sys.path.insert(0, 'app/e2e')
from upgrade_fixtures import load_fixtures
assets = load_fixtures()['1.10.5']  # ZIP + every original asset hash verified before swapping.
destination = pathlib.Path(sys.argv[1])
for name, value in assets.items():
    path = destination / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)
print('Verified 28 original 1.10.5 public assets; no historical native APK or signature used.')
PY
mkdir -p app/android/app/src/androidTest/assets/upgrade-fixtures
cp app/e2e/fixtures/upgrade/manifest.json app/e2e/fixtures/upgrade/gleam-1.10.5-public.zip app/android/app/src/androidTest/assets/upgrade-fixtures/
RESTORE_NEEDED=true
rm -rf "$PUBLIC"
cp -a "$WORK/old-public" "$PUBLIC"
if ! (cd app/android && HOME="$FIXTURE_HOME" ./gradlew --offline --no-daemon "-Duser.home=$FIXTURE_HOME" -PgleamFixtureVersion=1.10.5 :app:assembleDebug) >"$OUT/old-build.txt" 2>&1; then cat "$OUT/old-build.txt" >&2; exit 1; fi
test -s "$ANDROID_USER_HOME/debug.keystore"
# Export only the generated public certificate and tie every APK signer to this exact key.
KEYTOOL="${JAVA_HOME:+$JAVA_HOME/bin/}keytool"
"$KEYTOOL" -exportcert -keystore "$ANDROID_USER_HOME/debug.keystore" -alias androiddebugkey -storepass android -file "$OUT/fixture-signing-cert.der" >"$OUT/fixture-certificate.txt" 2>&1
cp app/android/app/build/outputs/apk/debug/app-debug.apk "$OUT/old-debug.apk"
restore
if ! (cd app/android && HOME="$FIXTURE_HOME" ./gradlew --offline --no-daemon "-Duser.home=$FIXTURE_HOME" :app:assembleDebug :app:assembleDebugAndroidTest) >"$OUT/current-build.txt" 2>&1; then cat "$OUT/current-build.txt" >&2; exit 1; fi
cp app/android/app/build/outputs/apk/debug/app-debug.apk "$OUT/current-debug.apk"
cp app/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk "$OUT/test-debug.apk"
# Exercise the release prohibition without building/signing any release artifact.
if (cd app/android && HOME="$FIXTURE_HOME" ./gradlew --offline --no-daemon "-Duser.home=$FIXTURE_HOME" -PgleamFixtureVersion=1.10.5 :app:assembleRelease --dry-run) >"$OUT/release-prohibition.txt" 2>&1; then
  echo 'Debug fixture version unexpectedly accepted a release task' >&2; exit 1
fi
grep -F 'gleamFixtureVersion is forbidden for every release task.' "$OUT/release-prohibition.txt"
for stage in old current test; do
  "$AAPT" dump badging "$OUT/$stage-debug.apk" >"$OUT/$stage-badging.txt"
  "$APKSIGNER" verify --print-certs "$OUT/$stage-debug.apk" >"$OUT/$stage-signer.txt"
done
"$AAPT" dump xmltree "$OUT/test-debug.apk" AndroidManifest.xml >"$OUT/test-manifest.txt"
python3 - "$OUT" <<'PY'
import hashlib, json, pathlib, re, sys
p = pathlib.Path(sys.argv[1]); signatures = []
def fixture_signer(text):
    digests = re.findall(r'^(?:Signer #\d+|V2 Signer:) certificate SHA-256 digest: ([0-9a-fA-F]{64})$', text, re.MULTILINE)
    assert digests and len(digests) == text.count('certificate SHA-256 digest:'), 'Unrecognized certificate output'
    unique = {digest.lower() for digest in digests}
    assert len(unique) == 1, 'Expected one unique fixture signing certificate'
    return unique.pop()
for stage in ('old', 'current', 'test'):
    text = (p / f'{stage}-signer.txt').read_text()
    signatures.append(fixture_signer(text))
assert len(set(signatures)) == 1, 'Harness debug signatures do not match'
assert signatures[0].lower() == hashlib.sha256((p/'fixture-signing-cert.der').read_bytes()).hexdigest(), 'APKs were not signed by the fresh fixture-only debug key'
def package(stage):
    text = (p / f'{stage}-badging.txt').read_text()
    match = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", text)
    assert match, f'Missing package version: {stage}'
    assert 'application-debuggable' in text, f'Non-debug APK refused: {stage}'
    return match.group(1), int(match.group(2)), match.group(3)
old, current = package('old'), package('current')
assert old == ('com.gleam.shiguang', 11005, '1.10.5'), old
assert current[0] == old[0] and current[1] > old[1] and current[2] != old[2], current
assert re.search(r"package: name='com\.gleam\.shiguang\.test'", (p/'test-badging.txt').read_text()), 'Unexpected test package'
assert 'application-debuggable' in (p/'test-badging.txt').read_text(), 'Non-debug instrumentation APK refused'
xml = (p/'test-manifest.txt').read_text().splitlines()
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
facts = {'scope': 'Self-built debug old-web/current-native harnesses; original historical native/signature compatibility untested',
         'old': old, 'current': current, 'debug_signer_sha256': signatures[0],
         'source_fixture_sha256': 'c6411b17b13e9cd495662f88a607dfbd848c2c06d7c3713f2c5b5c96b16c996e'}
(p / 'scope.json').write_text(json.dumps(facts, indent=2) + '\n')
with (p / 'stage-artifacts.sha256').open('w') as out:
    for stage in ('old', 'current', 'test'):
        name = f'{stage}-debug.apk'; out.write(f'{hashlib.sha256((p/name).read_bytes()).hexdigest()}  {name}\n')
print(json.dumps(facts))
PY
echo "Built private test APKs in $OUT; generated current public assets restored. No device or service used."
