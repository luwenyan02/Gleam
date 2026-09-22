# -*- coding: utf-8 -*-
"""使用虚构数据生成 README 脱敏截图。"""

import os
from pathlib import Path

from playwright.sync_api import sync_playwright


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4173/')
OUTPUT = Path(__file__).parents[2] / 'docs' / 'assets' / 'screenshots'
OUTPUT.mkdir(parents=True, exist_ok=True)


def book(page, entry_type: str, amount: str, category_name: str | None = None) -> None:
    if page.locator('#fab:visible').count() == 0:
        page.click('#tab-home')
    page.click('#fab')
    page.wait_for_selector('#sheet.open.entry-workspace')
    page.wait_for_timeout(350)
    page.click(f'#seg [data-type="{entry_type}"]')
    if category_name:
        category = page.locator('#cat-grid .cat', has_text=category_name)
        if category.count(): category.first.click()
    for char in amount:
        page.click(f'#keypad [data-k="{char}"]')
    page.click('#keypad [data-k="save"]')
    page.wait_for_selector('#sheet:not(.open)', state='attached')
    page.wait_for_timeout(350)


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
        page = context.new_page()
        page.goto(URL)
        page.wait_for_load_state('networkidle')
        page.wait_for_selector('.tabbar', timeout=15_000)

        book(page, 'expense', '36', '早餐')
        book(page, 'expense', '18', '午餐')
        book(page, 'income', '1200', '工资')
        page.click('#tab-home') if page.locator('#fab:visible').count() == 0 else None
        page.wait_for_timeout(2_200)
        page.screenshot(path=str(OUTPUT / 'home-demo.png'))

        page.click('.tab[data-page="page-report"]')
        page.wait_for_selector('#report-dim')
        page.click('#report-dim [data-dimension="category"]')
        page.wait_for_selector('#report-rank-card:not([hidden]) .rank-link')
        page.wait_for_timeout(350)
        page.screenshot(path=str(OUTPUT / 'report-demo.png'))

        page.click('.tab[data-page="page-life"]')
        page.wait_for_selector('#lf-types')
        page.click('#lf-types')
        page.click('#sheet [data-type="habit"]')
        page.fill('#lf-hname', '晚饭后散步')
        page.click('#sheet [data-act="save"]')
        page.wait_for_selector('#lf-feed .habit')
        page.click('#lf-types')
        page.click('#sheet [data-type="diary"]')
        page.fill('#lf-title', '初秋的傍晚')
        page.fill('#lf-body', '风很轻，沿着河边慢慢走了一圈。')
        page.click('#sheet [data-act="save"]')
        page.wait_for_selector('#lf-feed [data-note]')
        page.wait_for_timeout(2_200)
        page.screenshot(path=str(OUTPUT / 'life-demo.png'))

        context.close()
        browser.close()
        print(f'generated: {OUTPUT}')


if __name__ == '__main__':
    main()
