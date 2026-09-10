"""首页模块排序、快捷配置和模板入口，全部为隔离虚构数据。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/home-configuration'

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
            page.wait_for_selector('#hm-quick:not([hidden])')
            assert page.locator('#hm-quick .qa').count() == 5
            quick_buttons = page.locator('#hm-quick button').evaluate_all(
                "els => els.map(el => ({text: el.textContent.trim(), ...el.getBoundingClientRect().toJSON()}))"
            )
            assert len(quick_buttons) == 6
            assert quick_buttons[-1]['text'] == '全部'
            assert abs(quick_buttons[-1]['top'] - quick_buttons[0]['top']) < 1, '“全部”不应另起一行'
            assert all(button['width'] >= 43 and button['height'] >= 43 for button in quick_buttons)
            page.click('#btn-home-edit')
            page.wait_for_selector('[data-sw="today"]')
            page.click('[data-move="quick"][data-step="-1"]')
            page.wait_for_function("document.querySelector('#homeedit-list [data-mod]')?.dataset.mod === 'quick'")
            page.click('[data-quick="ai"]')
            page.wait_for_selector('[data-quick="ai"][aria-checked="false"]')
            page.click('[data-quick="budget"]')
            page.wait_for_selector('[data-quick="budget"][aria-checked="true"]')
            page.wait_for_timeout(350)
            page.screenshot(path=str(OUT / f'config-{width}.png'))
            page.click('#sp-home-custom .sub-head [data-act="back"]')
            page.wait_for_selector('#sp-home-custom', state='detached')
            page.wait_for_selector('#hm-quick [data-qa="budget"]')
            assert page.locator('#hm-quick .qa').count() == 5
            assert page.locator('#hm-quick').bounding_box()['y'] < page.locator('#hm-month').bounding_box()['y']
            page.click('#hm-quick [data-qa="note"]')
            page.wait_for_selector('#sp-template-manage.open')
            page.click('#sp-template-manage .sub-head [data-act="back"]')
            page.wait_for_selector('#sp-template-manage', state='detached')
            page.wait_for_timeout(350)
            page.screenshot(path=str(OUT / f'home-{width}.png'))
            assert not errors, errors
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            page.reload()
            page.wait_for_selector('#hm-quick [data-qa="budget"]')
            assert page.locator('#hm-quick').bounding_box()['y'] < page.locator('#hm-month').bounding_box()['y']
            print(f'PASS home configuration, persistence, empty template {width}', flush=True)
            ctx.close()
        browser.close()
if __name__ == '__main__': main()
