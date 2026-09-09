"""虚构数据下的筛选输入与取消行为回归。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/query-integrity'

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
            page.wait_for_selector('#fab')
            page.click('#btn-search')
            page.wait_for_selector('#sr-dates')
            active = page.locator('#sr-dates .active').inner_text()
            page.click('#sr-dates [data-range="custom"]')
            page.wait_for_selector('.dw-panel[aria-modal="true"].dw-open')
            page.keyboard.press('Escape')
            page.wait_for_selector('.dw-mask', state='detached')
            assert page.locator('#sr-dates .active').inner_text() == active
            page.click('#sr-adv-filter')
            for value in ('-1', '1e2', '1.001'):
                page.fill('#fp-min', value)
                page.click('.fp-ok')
                assert page.locator('.fp-panel').is_visible()
            page.fill('#fp-min', '3')
            page.fill('#fp-max', '2')
            page.click('.fp-ok')
            assert page.locator('.fp-panel').is_visible()
            page.fill('#fp-min', '0.01')
            page.fill('#fp-max', '12.34')
            page.click('.fp-ok')
            page.wait_for_selector('.fp-panel', state='detached')
            page.wait_for_selector('#sr-active-filters:not([hidden])')
            assert '0.01' in page.inner_text('#sr-active-filters')
            page.wait_for_timeout(400)
            page.screenshot(path=str(OUT / f'filters-{width}.png'))
            assert not errors, errors
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            print(f'PASS query validation, cancel, layout {width}', flush=True)
            ctx.close()
        browser.close()
if __name__ == '__main__':
    main()
