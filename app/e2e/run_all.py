# -*- coding: utf-8 -*-
"""Run the complete browser regression suite against one preview server."""

import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

APP_ROOT = Path(__file__).parents[1]
PROJECT_ROOT = APP_ROOT.parent
URL = 'http://127.0.0.1:4601/'
TESTS = (
    'test_acceptance.py', 'test_refund.py', 'test_m3.py', 'test_ux_m1.py', 'test_ux_m2.py',
    'test_ux_m3.py', 'test_acceptance_fixes.py', 'test_requested_refinements.py',
    'test_loan_accounts.py', 'test_list_rows_and_back.py', 'test_calculator_safety.py',
    'test_save_atomic.py', 'test_recurring_safety.py', 'test_import_safety.py',
    'test_stats_safety.py', 'test_backup_integrity.py', 'test_text_clarity.py',
)


def server_ready() -> bool:
    try:
        with urllib.request.urlopen(URL, timeout=1) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError):
        return False


def wait_for_server(process: subprocess.Popen[str], timeout: float = 20) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server_ready():
            return
        if process.poll() is not None:
            raise RuntimeError('预览服务提前退出')
        time.sleep(0.2)
    raise RuntimeError('预览服务未在 20 秒内就绪')


def main() -> int:
    server = None
    env = os.environ.copy()
    screenshots = PROJECT_ROOT / '.tmp' / 'tests' / 'e2e' / 'screenshots'
    screenshots.mkdir(parents=True, exist_ok=True)
    env['GLEAM_E2E_SCREENSHOTS'] = str(screenshots)
    env['GLEAM_E2E_URL'] = URL

    try:
        if not server_ready():
            server = subprocess.Popen(
                ['npm', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', '4601'],
                cwd=APP_ROOT,
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
            wait_for_server(server)

        for test in TESTS:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).parent / test)],
                cwd=APP_ROOT,
                env=env,
            )
            if result.returncode != 0:
                return result.returncode
        return 0
    finally:
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()


if __name__ == '__main__':
    raise SystemExit(main())
