"""使用固定、校验过的 Gitleaks 扫描全部本地 Git refs；不自动 fetch。"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = '8.30.1'
ARCHIVE_URL = f'https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/gitleaks_{VERSION}_linux_x64.tar.gz'
ARCHIVE_SHA256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'
BINARY_SHA256 = '88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509'
CACHE_BINARY = ROOT / '.tmp/tools/gitleaks' / VERSION / 'gitleaks'
IGNORE_POLICY = ROOT / '.gitleaksignore'
REVIEWED_IGNORES = frozenset({
    '0b09da8f1c05465d90108d3e0d83b33e9a51dda5:app/e2e/upgrade_fixtures.py:generic-api-key:13',
    'fa9ac2da649f836a96049dc9f01f96ef442832c1:app/e2e/upgrade_fixtures.py:generic-api-key:13',
})
MAX_DOWNLOAD = 32 * 1024 * 1024
MAX_BINARY = 64 * 1024 * 1024
SCAN_TIMEOUT = 240
PRIVATE_PATHS = re.compile(
    r'^(?:uploads|release|\.tmp|\.selftest|outputs)/'
    r'|(?:^|/)(?:wacai\.xls|local\.properties|\.env(?:\.[^/]*)?)$'
    r'|(?:^|/)(?:id_rsa|id_ecdsa|id_ed25519)$|(?:^|/)\.secrets(?:/|$)'
    r'|\.(?:keystore|jks|p12|pfx|pkcs12|pem|key|apk|aab)$', re.IGNORECASE)


class ScanError(Exception):
    """固定的、可安全显示的诊断；不拼接异常或进程原文。"""


def ensure_binary():
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
        raise ScanError('Gitleaks requires Linux x86_64.')
    if CACHE_BINARY.exists() or CACHE_BINARY.is_symlink():
        if (CACHE_BINARY.is_symlink() or not CACHE_BINARY.is_file()
                or CACHE_BINARY.stat().st_size > MAX_BINARY
                or hashlib.sha256(CACHE_BINARY.read_bytes()).hexdigest() != BINARY_SHA256):
            raise ScanError('Cached Gitleaks integrity check failed.')
        return CACHE_BINARY
    chunks, size, started = [], 0, time.monotonic()
    with urllib.request.urlopen(ARCHIVE_URL, timeout=30) as response:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_DOWNLOAD or time.monotonic() - started > 60:
                raise ScanError('Gitleaks download exceeded its limit.')
            chunks.append(chunk)
    archive = b''.join(chunks)
    if hashlib.sha256(archive).hexdigest() != ARCHIVE_SHA256:
        raise ScanError('Gitleaks archive integrity check failed.')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
        members = [member for member in package.getmembers() if member.name == 'gitleaks']
        if len(members) != 1 or not members[0].isfile() or members[0].size > MAX_BINARY:
            raise ScanError('Gitleaks archive has an invalid binary entry.')
        with package.extractfile(members[0]) as source:
            binary = source.read(MAX_BINARY + 1)
    if hashlib.sha256(binary).hexdigest() != BINARY_SHA256:
        raise ScanError('Gitleaks binary integrity check failed.')
    CACHE_BINARY.parent.mkdir(parents=True, exist_ok=True)
    # Atomic publication also lets concurrent read-only checks share the cache.
    with tempfile.NamedTemporaryFile(dir=CACHE_BINARY.parent, delete=False) as target:
        temporary = Path(target.name)
        try:
            target.write(binary)
            target.close()
            temporary.chmod(0o700)
            temporary.replace(CACHE_BINARY)
        finally:
            temporary.unlink(missing_ok=True)
    return CACHE_BINARY


def git_output(repo, env, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True,
                            env=env, timeout=30)
    if result.returncode:
        raise ScanError('Cannot read complete Git history; raw diagnostics suppressed.')
    return result.stdout


def read_report(result, report, messages=None):
    if result.returncode not in (0, 10):
        raise ScanError('Gitleaks scan failed; raw diagnostics suppressed.')
    if not report.is_file() or report.stat().st_size > 100 * 1024 * 1024:
        raise ScanError('Gitleaks did not produce a valid bounded report.')
    findings = json.loads(report.read_text())
    if not isinstance(findings, list) or bool(findings) != (result.returncode == 10):
        raise ScanError('Gitleaks report and exit status disagree.')
    locations = []
    for finding in findings:
        if (not isinstance(finding, dict) or not isinstance(finding.get('File'), str)
                or not re.fullmatch(r'[a-zA-Z0-9_-]+', str(finding.get('RuleID', '')))
                or type(finding.get('StartLine')) is not int):
            raise ScanError('Gitleaks report contains an invalid location.')
        if messages is None:
            path, commit = finding['File'], finding.get('Commit', '')
        else:
            location = messages.get(Path(finding['File']).name)
            if location is None:
                raise ScanError('Gitleaks message report contains an unknown location.')
            path, commit = location
        if not re.fullmatch(r'[0-9a-f]{40,64}', commit):
            raise ScanError('Gitleaks report contains an invalid commit.')
        locations.append({'path': path, 'rule': finding['RuleID'],
                          'commit': commit, 'line': finding['StartLine']})
    return locations


def scan(repo, binary):
    entries = [line.strip() for line in IGNORE_POLICY.read_text().splitlines()
               if line.strip() and not line.lstrip().startswith('#')]
    if len(entries) != len(REVIEWED_IGNORES) or set(entries) != REVIEWED_IGNORES:
        raise ScanError('History ignore policy differs from the two reviewed APK fingerprints.')
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('GITLEAKS_', 'GIT_'))}
    env.update(GIT_NO_REPLACE_OBJECTS='1', GIT_NO_LAZY_FETCH='1',
               GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
    shallow = git_output(repo, env, 'rev-parse', '--is-shallow-repository').strip()
    if shallow not in (b'true', b'false'):
        raise ScanError('Cannot verify Git repository history.')
    if shallow == b'true':
        raise ScanError('Shallow Git history cannot be scanned; fetch complete history first.')
    git_dir = git_output(repo, env, 'rev-parse', '--absolute-git-dir').decode().strip()
    commits = git_output(repo, env, 'rev-list', '--all').decode('ascii').splitlines()
    work = ROOT / '.tmp/work'
    work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='history-scan-', dir=work) as temporary:
        temporary = Path(temporary)
        config = temporary / 'defaults.toml'
        config.write_text('[extend]\nuseDefault = true\n')
        message_dir = temporary / 'messages'
        message_dir.mkdir()
        messages, locations, prohibited = {}, [], set()
        for commit in commits:
            if not re.fullmatch(r'[0-9a-f]{40,64}', commit):
                raise ScanError('Git returned an invalid commit identifier.')
            name = f'commit-{commit}.txt'
            (message_dir / name).write_bytes(git_output(repo, env, 'cat-file', 'commit', commit))
            messages[name] = ('commit-message', commit)
            # Trees expose path names only; binary signing contents are never read.
            paths = git_output(repo, env, 'ls-tree', '-r', '-z', '--name-only', commit)
            for raw_path in paths.split(b'\0'):
                path = raw_path.decode('utf-8', errors='replace')
                if (path and PRIVATE_PATHS.search(path)
                        and Path(path).name != '.env.example' and path not in prohibited):
                    prohibited.add(path)
                    locations.append({'path': path, 'rule': 'forbidden-history-path',
                                      'commit': commit, 'line': 0})
        tags = git_output(repo, env, 'for-each-ref', '--format=%(objecttype) %(objectname)')
        pending = [line.split()[1] for line in tags.decode('ascii').splitlines()
                   if line.split()[0] == 'tag']
        visited = set()
        while pending:
            oid = pending.pop()
            if oid in visited:
                continue
            visited.add(oid)
            raw = git_output(repo, env, 'cat-file', 'tag', oid)
            name = f'tag-{oid}.txt'
            (message_dir / name).write_bytes(raw)
            messages[name] = ('tag-message', oid)
            # Annotated tags may point at another annotated tag with no direct ref.
            headers = dict(line.split(b' ', 1) for line in raw.split(b'\n\n', 1)[0].splitlines()
                           if b' ' in line)
            target = headers.get(b'object', b'').decode('ascii')
            if not re.fullmatch(r'[0-9a-f]{40,64}', target):
                raise ScanError('Git tag contains an invalid target identifier.')
            if git_output(repo, env, 'cat-file', '-t', target).strip() == b'tag':
                pending.append(target)
        common = ['--config', str(config), '--ignore-gitleaks-allow', '--redact=100',
                  '--no-banner', '--no-color', '--exit-code=10', '--timeout', str(SCAN_TIMEOUT),
                  '--report-format=json']
        # Gitleaks also auto-loads source/.gitleaksignore even with an explicit
        # policy flag. An empty source plus GIT_DIR prevents target-controlled ignores.
        git_source = temporary / 'git-source'
        git_source.mkdir()
        report = temporary / 'history.json'
        result = subprocess.run([
            str(binary), 'git', *common, '--gitleaks-ignore-path', str(IGNORE_POLICY.resolve()),
            '--report-path', str(report),
            '--log-opts=--all --full-history --diff-merges=first-parent --root --no-ext-diff --no-textconv',
            str(git_source),
        ], capture_output=True, env={**env, 'GIT_DIR': git_dir}, timeout=SCAN_TIMEOUT + 10)
        locations.extend(read_report(result, report))
        report = temporary / 'messages.json'
        result = subprocess.run([
            str(binary), 'dir', *common,
            '--gitleaks-ignore-path', str(temporary / 'no-message-ignores'),
            '--report-path', str(report), str(message_dir),
        ], capture_output=True, env=env, timeout=SCAN_TIMEOUT + 10)
        locations.extend(read_report(result, report, messages))
        for location in locations:
            print(json.dumps(location, ensure_ascii=True))
        print(f'History secrets scan: {len(locations)} finding(s).')
        return 1 if locations else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=ROOT, help='complete local Git checkout or bare repository')
    args = parser.parse_args(argv)
    try:
        return scan(args.repo.resolve(), ensure_binary())
    except ScanError as error:
        print(f'History secrets scan failed: {error}')
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError):
        print('History secrets scan failed; raw diagnostics suppressed.')
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
