#!/usr/bin/env python3
"""Rebuild the Linux web toolchain locally; never configure a saved cloud environment."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'app'
STATE = ROOT / '.tmp' / 'cloud-env'
NODE_VERSION = (ROOT / '.node-version').read_text().strip()
# Official https://nodejs.org/dist/v22.23.3/SHASUMS256.txt, checked 2026-10-12.
# Update these hashes together with .node-version; never trust a cached archive.
NODE_SHA256 = {
    'x64': 'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de',
    'arm64': 'a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f',
}
NODE = STATE / f'node-{NODE_VERSION}'
VENV = STATE / 'python'
NPM_VERSION = json.loads((APP / 'package.json').read_text())['packageManager'].removeprefix('npm@')


def environment():
    # Deliberately do not inherit service keys, NODE_OPTIONS, npm/pip configs,
    # browser overrides or a user's live preview URL. This is not a network sandbox.
    for directory in ('home', 'cache', 'tmp', 'browsers'):
        (STATE / directory).mkdir(parents=True, exist_ok=True)
    return {
        'PATH': os.pathsep.join([str(NODE / 'bin'), str(VENV / 'bin'), os.defpath]),
        'HOME': str(STATE / 'home'), 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'CI': '1',
        'TMPDIR': str(STATE / 'tmp'), 'XDG_CACHE_HOME': str(STATE / 'cache'),
        'npm_config_cache': str(STATE / 'cache' / 'npm'),
        'npm_config_registry': 'https://registry.npmjs.org/',
        'PIP_CONFIG_FILE': os.devnull,
        'PLAYWRIGHT_BROWSERS_PATH': str(STATE / 'browsers'),
    }


def run(argv, *, cwd=APP):
    print('+ ' + ' '.join(map(str, argv)), flush=True)
    subprocess.run(list(map(str, argv)), cwd=cwd, env=environment(), check=True)


def no_local_env_files():
    # Vite loads .env files even when the process environment was sanitized.
    names = sorted(p.name for p in APP.glob('.env*') if p.name != '.env.example')
    if names:
        raise RuntimeError('Use a clean checkout without local .env files; contents were not read: ' + ', '.join(names))


def versions():
    if not (NODE / 'bin' / 'node').is_file() or not (VENV / 'bin' / 'python3').is_file():
        raise RuntimeError('Local Node/Python environment is missing; run setup first')
    for command, expected in [(['node', '--version'], 'v' + NODE_VERSION), (['npm', '--version'], NPM_VERSION)]:
        actual = subprocess.check_output(command, cwd=APP, env=environment(), text=True).strip()
        if actual != expected:
            raise RuntimeError(f'{command[0]}: expected {expected}, got {actual}; run setup')
        print(f'{command[0]} {actual}', flush=True)
    run(['python3', '--version'])


def setup():
    no_local_env_files()
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    if platform.system() != 'Linux' or arch is None:
        raise RuntimeError('This bootstrap supports Linux x86_64/aarch64; use docs/development.md elsewhere')
    if not NODE.exists():
        filename = f'node-v{NODE_VERSION}-linux-{arch}.tar.xz'
        with tempfile.TemporaryDirectory(prefix='node-download-', dir=STATE) as temporary:
            archive = Path(temporary) / filename
            url = f'https://nodejs.org/dist/v{NODE_VERSION}/{filename}'
            print(f'Download {url}', flush=True)
            with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if hashlib.sha256(archive.read_bytes()).hexdigest() != NODE_SHA256[arch]:
                raise RuntimeError('Official Node archive SHA-256 mismatch; not extracting')
            run(['tar', '-xJf', archive, '-C', temporary], cwd=ROOT)
            (Path(temporary) / filename.removesuffix('.tar.xz')).rename(NODE)
    if not (VENV / 'bin' / 'python3').exists():
        run([sys.executable, '-m', 'venv', VENV], cwd=ROOT)
    versions()
    # Same install policy as CI. npm ci replaces only this checkout's node_modules.
    run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    run(['python3', '-m', 'pip', 'install', '--index-url', 'https://pypi.org/simple', '-r', 'e2e/requirements.txt'])
    run(['python3', '-m', 'playwright', 'install', 'chromium'])
    print('Setup complete. Run check, then verify. System libraries are never installed automatically.')


def check():
    versions()
    run(['npm', 'ls', '--all', '--offline'])
    run(['python3', '-c', "from importlib.metadata import version; from pathlib import Path; expected=Path('e2e/requirements.txt').read_text().strip().split('==')[1]; assert version('playwright') == expected, version('playwright'); print('Playwright', expected)"])
    run(['python3', '-c', 'from playwright.sync_api import sync_playwright\nwith sync_playwright() as p:\n b=p.chromium.launch(headless=True)\n print("Chromium", b.version)\n b.close()'])


def verify():
    no_local_env_files()
    check()
    # Fail fast and preserve each command's real exit code. No audit/real API calls.
    for command in [
        ['python3', '../scripts/test-cloud-env.py'],
        ['npm', 'run', 'check:secrets'],
        ['npm', 'run', 'test:unit'],
        ['npm', 'run', 'test:ai-eval'],
        ['node', 'node_modules/typescript/bin/tsc', '--noEmit'],
        ['npm', 'run', 'build'],
        ['npm', 'run', 'test:e2e'],
    ]:
        run(command)


def main():
    if sys.version_info < (3, 11):
        raise RuntimeError('Python 3.11+ with venv/pip is required')
    environment()
    action = sys.argv[1:2]
    if action == ['setup']:
        setup()
    elif action == ['check']:
        check()
    elif action == ['verify']:
        verify()
    elif action == ['run'] and len(sys.argv) > 2:
        no_local_env_files()
        versions()
        run(sys.argv[2:])
    else:
        raise RuntimeError('Usage: python3 scripts/cloud-env.py {setup|check|verify|run COMMAND...}')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode)
    except (OSError, RuntimeError) as error:
        print(f'Cloud environment: {error}', file=sys.stderr)
        raise SystemExit(1)
