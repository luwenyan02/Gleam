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
    'test_runner_unit.py',
    'test_web_pwa_registration.py',
    'test_spending_rhythm.py', 'test_chat_ledger_recent.py',
    'test_home_monthly_timeline.py',
    'test_page_open_performance.py',
    'test_ui_consistency.py',
    'test_overview_art.py',
    'test_upgrade_cache_unit.py', 'test_upgrade_cache.py',
    'test_ai_key_settings.py',
    'test_app_version.py',
    'test_app_update.py',
    'test_category_icons.py', 'test_category_merge_and_navigation.py', 'test_category_entry_counts.py', 'test_xiaomi14_layout.py',
    'test_form_input_layout.py', 'test_entry_amount_replace.py',
    'test_entry_feedback.py', 'test_entry_keypad.py', 'test_entry_copy_edit.py', 'test_mine_performance.py', 'test_entry_account_picker.py', 'test_hold_voice.py', 'test_hold_voice_handoff.py', 'test_inbox_hold_voice.py', 'test_short_voice.py', 'test_short_voice_interaction.py', 'test_voice_diagnostics.py', 'test_settings_declutter.py', 'test_help_manual.py', 'test_chat_ledger_context.py', 'test_chat_ledger_analysis.py', 'test_chat_markdown.py',
    'test_acceptance.py', 'test_refund.py', 'test_refund_layout.py', 'test_refund_account_picker.py', 'test_m3.py', 'test_ux_m1.py', 'test_quick_templates.py', 'test_ux_m2.py',
    'test_ux_m3.py', 'test_acceptance_fixes.py', 'test_requested_refinements.py',
    'test_loan_accounts.py', 'test_list_rows_and_back.py', 'test_calculator_safety.py',
    'test_save_atomic.py', 'test_recurring_safety.py', 'test_import_safety.py', 'test_wacai_replace.py',
    'test_stats_safety.py', 'test_backup_integrity.py', 'test_email_backup.py', 'test_backup_history.py', 'test_backup_settings_clarity.py', 'test_text_clarity.py', 'test_ui_refinements.py', 'test_recurring_types_ui.py',
    'test_home_configuration.py', 'test_query_integrity.py', 'test_budget_periods.py', 'test_budget_category_details.py',
    'test_calendar_daylist.py', 'test_report_composition.py', 'test_credit_statements.py',
    'test_account_reconcile_credit_limit.py',
    'test_account_search_navigation.py', 'test_account_management_ui.py', 'test_account_active_months.py', 'test_account_footer_trend.py', 'test_net_worth_trend.py',
    'test_account_detail_performance.py', 'test_account_detail_upgrade.py', 'test_account_detail_pagination.py',
    'test_entry_receipts.py', 'test_entry_detail_performance.py', 'test_entry_detail_upgrade.py',
    'test_entity_details.py', 'test_accounting_period.py', 'test_search_month_ranges.py', 'test_search_summary_layout.py', 'test_search_filter_groups.py',
    'test_life_layout.py', 'test_entry_life_memory.py', 'test_life_ai.py', 'test_chat_experience.py', 'test_chat_resume.py', 'test_chat_web_search.py', 'test_chat_ai_settings.py',
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

        failures = []
        for test in TESTS:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).parent / test)],
                cwd=APP_ROOT,
                env=env,
            )
            if result.returncode != 0:
                failures.append((test, result.returncode))
        if failures:
            print(f"Browser acceptance failed: {failures}", file=sys.stderr, flush=True)
            return 1
        # Publishable previews use their own fresh, fictional browser contexts.
        # Keep this separate from the regression suites and leave outputs in .tmp.
        return subprocess.run(
            [sys.executable, str(Path(__file__).parent / 'capture_readme.py')],
            cwd=APP_ROOT,
            env=env,
        ).returncode
    finally:
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()


if __name__ == '__main__':
    raise SystemExit(main())
