# -*- coding: utf-8 -*-
"""计算器账务安全回归；每个场景使用独立浏览器上下文与虚构数据。"""

import os
import traceback

from playwright.sync_api import sync_playwright


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')


def entry_count(page) -> int:
    return page.evaluate('''async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count = await new Promise((resolve, reject) => {
        const request = db.transaction('entries').objectStore('entries').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return count;
    }''')


def press(page, *keys: str) -> None:
    for key in keys:
        page.locator(f'#keypad [data-k="{key}"]').click()


def open_entry(page) -> None:
    page.locator('#fab').click()
    page.locator('#sheet.open.entry-workspace #keypad').wait_for()


def enter_division_by_zero(page) -> None:
    press(page, '5', 'md', 'md', '0')
    assert '5 ÷ 0' in page.locator('#amt').inner_text()


def division_by_zero_on_save(page) -> None:
    before = entry_count(page)
    open_entry(page)
    enter_division_by_zero(page)
    press(page, 'save')
    page.locator('#toast.show').wait_for()
    assert page.locator('#toast').inner_text() == '除数不能为零'
    assert page.locator('#sheet.open.entry-workspace').count() == 1
    assert '5 ÷ 0' in page.locator('#amt').inner_text()
    assert entry_count(page) == before


def division_by_zero_on_operator(page) -> None:
    open_entry(page)
    enter_division_by_zero(page)
    press(page, '+')
    page.locator('#toast.show').wait_for()
    assert page.locator('#toast').inner_text() == '除数不能为零'
    assert '5 ÷ 0' in page.locator('#amt').inner_text()


def negative_amount_is_not_saved(page) -> None:
    before = entry_count(page)
    open_entry(page)
    press(page, '5', '-', '8', '=')
    assert page.locator('#amt').inner_text() == '-3'
    press(page, 'save')
    page.locator('#toast.show').wait_for()
    assert '金额格式非法' in page.locator('#toast').inner_text()
    assert page.locator('#sheet.open.entry-workspace').count() == 1
    assert entry_count(page) == before


def left_to_right_keeps_negative_intermediate(page) -> None:
    open_entry(page)
    press(page, '5', '-', '8', '+', '1', '0', '=')
    assert page.locator('#amt').inner_text() == '7'


def large_intermediate_keeps_every_cent(page) -> None:
    open_entry(page)
    press(page, *'50000000', 'md', *'900000', '=')
    assert page.locator('#amt').inner_text() == '45000000000000'
    press(page, '+', *'0.02', '=')
    assert page.locator('#amt').inner_text() == '45000000000000.02'
    press(page, '+')
    assert page.locator('#amt').inner_text().startswith('45000000000000.02 +')
    press(page, '0', '=')
    assert page.locator('#amt').inner_text() == '45000000000000.02'


if __name__ == '__main__':
    failures = []
    cases = (
        division_by_zero_on_save,
        division_by_zero_on_operator,
        negative_amount_is_not_saved,
        left_to_right_keeps_negative_intermediate,
        large_intermediate_keeps_every_cent,
    )
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for case in cases:
            context = browser.new_context(
                viewport={'width': 390, 'height': 844},
                service_workers='block',
            )
            page = context.new_page()
            page.set_default_timeout(7_000)
            try:
                page.goto(URL)
                page.wait_for_load_state('networkidle')
                page.locator('#fab').wait_for()
                case(page)
                print('PASS', case.__name__, flush=True)
            except Exception:  # noqa: BLE001
                failures.append(case.__name__)
                print('FAIL', case.__name__, traceback.format_exc(), flush=True)
            finally:
                context.close()
        browser.close()
    raise SystemExit(1 if failures else 0)
