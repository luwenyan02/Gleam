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
URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
EXTERNAL_URL = 'GLEAM_E2E_URL' in os.environ
TESTS = (
    'test_acceptance.py', 'test_refund.py', 'test_m3.py', 'test_ux_m1.py', 'test_ux_m2.py',
    'test_ux_m3.py', 'test_acceptance_fixes.py', 'test_requested_refinements.py',
    'test_loan_accounts.py', 'test_list_rows_and_back.py', 'test_calculator_safety.py',
    'test_save_atomic.py', 'test_recurring_safety.py', 'test_import_safety.py',
    'test_stats_safety.py', 'test_backup_integrity.py', 'test_text_clarity.py', 'test_recurring_types_ui.py',
    'test_home_configuration.py', 'test_query_integrity.py', 'test_budget_periods.py',
    'test_calendar_daylist.py', 'test_credit_statements.py',
    'test_account_reconcile_credit_limit.py',
    'test_account_management_ui.py',
    'test_entry_receipts.py',
    'test_entity_details.py', 'test_accounting_period.py',
    'test_life_ai.py',
    'test_browser_usability.py',
    'test_large_ledger.py',
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
            if EXTERNAL_URL:
                raise RuntimeError(f'指定的验收地址不可访问：{URL}')
            server = subprocess.Popen(
                ['npm', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', '4617'],
                cwd=APP_ROOT,
                env=env,
                text=True,
                # The preview server stays alive for the whole suite.  Leaving its
                # output attached to an unread pipe eventually fills the buffer and
                # blocks asset responses near the end of a long regression run.
                stdout=subprocess.DEVNULL,
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
