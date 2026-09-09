"""预算历史、复制和年度设置，隔离虚构数据四屏宽回归。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/budget-periods'

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1024):
            ctx = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block')
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(URL)
            page.wait_for_selector('#hm-quick')
            page.click('#hm-quick .hm-all')
            page.get_by_text('预算', exact=True).last.click()
            page.wait_for_selector('#sp-budget.open')
            page.click('[data-act="period"]')
            page.evaluate("document.querySelector('.dw-panel').__mwSet(2025, 12)")
            page.click('.dw-confirm')
            page.wait_for_selector('.dw-panel', state='detached')
            page.click('#sp-budget [data-bd-set]')
            page.fill('#bd-total', '1200.50')
            page.click('#sheet [data-act="save"]')
            page.wait_for_function("document.querySelector('#sp-budget .big')?.textContent.includes('1,200.50')")
            assert '日均可用' not in page.inner_text('#sp-budget')
            page.click('[data-act="period"]')
            page.evaluate("document.querySelector('.dw-panel').__mwSet(2026, 1)")
            page.click('.dw-confirm')
            page.wait_for_selector('.dw-panel', state='detached')
            page.click('[data-act="copy"]')
            page.wait_for_function("document.querySelector('#sp-budget .big')?.textContent.includes('1,200.50')")
            page.click('[data-act="mode"]')
            page.click('#sp-budget [data-bd-set]')
            page.fill('#bd-annual', '24000.75')
            page.click('#sheet [data-act="save"]')
            page.wait_for_function("document.querySelector('#sp-budget .big')?.textContent.includes('24,000.75')")
            page.wait_for_timeout(2400)
            page.screenshot(path=str(OUT / f'annual-{width}.png'))
            assert not errors, errors
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            print(f'PASS budget history, copy, annual {width}', flush=True)
            ctx.close()
        browser.close()
if __name__ == '__main__': main()
