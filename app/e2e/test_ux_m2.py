# -*- coding: utf-8 -*-
"""M2 统一明细、报表下钻与账户详情联动验收。"""

import os
import sys
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4173/')
SCREENSHOTS = Path(os.environ.get(
    'GLEAM_E2E_SCREENSHOTS',
    Path(__file__).parents[2] / '.tmp' / 'tests' / 'e2e' / 'screenshots',
))
SCREENSHOTS.mkdir(parents=True, exist_ok=True)


def book(page, entry_type: str, amount: str) -> None:
    if page.locator('#fab:visible').count() == 0:
        page.click('#tab-home')
    page.click('#fab')
    page.wait_for_selector('#sheet.open.entry-workspace')
    page.wait_for_timeout(350)
    page.click(f'#seg [data-type="{entry_type}"]')
    for char in amount:
        page.click(f'#keypad [data-k="{char}"]')
    page.click('#keypad [data-k="save"]')
    page.wait_for_selector('#sheet:not(.open)', state='attached')


def main() -> int:
    failure = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
        page = context.new_page()
        page.on('pageerror', lambda error: print(f'PAGEERROR: {error}', flush=True))
        try:
            page.goto(URL)
            page.wait_for_load_state('networkidle')
            page.wait_for_selector('.tabbar', timeout=15_000)
            book(page, 'expense', '12')
            book(page, 'income', '30')

            page.click('.tab[data-page="page-report"]')
            page.wait_for_selector('#report-dim')
            page.wait_for_function("document.querySelector('#r-spend')?.textContent?.includes('12.00')")
            assert page.locator('#r-seg [data-p]').count() == 4
            assert page.locator('#report-dim [data-dimension]').count() == 4
            assert '30.00' in page.inner_text('#r-income')

            page.click('#report-dim [data-dimension="category"]')
            page.wait_for_selector('#report-rank-card:not([hidden]) .rank-link')
            page.wait_for_timeout(250)
            page.screenshot(path=str(SCREENSHOTS / 'm2-report-390x844.png'))
            page.evaluate("document.querySelector('#page-report').scrollTop = 120")
            scroll_before = page.eval_on_selector('#page-report', 'el => el.scrollTop')
            page.click('#report-rank-card .rank-link')
            page.wait_for_selector('#sp-search.open #sr-results .sr-summary-row')
            page.wait_for_selector('#sp-search .sr-day-head')
            page.wait_for_timeout(400)
            assert '12.00' in page.inner_text('#sp-search .sr-summary-card[data-sf="expense"]')
            filters = page.inner_text('#sp-search #sr-active-filters')
            assert '自定义日期' in filters and '类型：支出' in filters
            page.screenshot(path=str(SCREENSHOTS / 'm2-search-drilldown-390x844.png'))

            page.click('#sp-search .sub-head [data-act="back"]')
            page.wait_for_selector('#sp-search', state='detached')
            assert page.locator('#report-dim [data-dimension="category"].active').count() == 1
            assert page.eval_on_selector('#page-report', 'el => el.scrollTop') == scroll_before

            page.click('.tab[data-page="page-acct"]')
            page.wait_for_selector('[data-acct]')
            page.locator('[data-acct]').first.click()
            page.wait_for_selector('#sp-account-detail.open #account-months')
            page.wait_for_timeout(400)
            assert page.locator('#sp-account-detail .spark').count() == 1
            assert page.locator('#sp-account-detail [data-account-month]').count() >= 1
            assert page.locator('#account-detail-entry:visible').count() == 1, '账户详情底部应有固定快速记账入口'

            page.screenshot(path=str(SCREENSHOTS / 'm2-report-account-390x844.png'))
            print('PASS M2 query/report/account', flush=True)
        except Exception as error:  # noqa: BLE001
            failure = f'{error}\n{traceback.format_exc()}'
            page.screenshot(path=str(SCREENSHOTS / 'm2-report-account-fail.png'))
            print(f'FAIL M2 query/report/account: {error}', flush=True)
        finally:
            context.close()
            browser.close()

    if failure:
        print(failure)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
