"""主要页面的响应式、触控尺寸与网页版提醒回归，全部使用隔离浏览器数据。"""

import os
from pathlib import Path

from playwright.sync_api import sync_playwright


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/browser-usability'


def assert_usable(page, selector: str) -> None:
    result = page.evaluate(
        """selector => {
          const root = document.querySelector(selector);
          const visible = el => {
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden'
              && rect.width > 0 && rect.height > 0;
          };
          const tooSmall = [...root.querySelectorAll('button,[role=button],[role=switch],input,textarea,select')]
            .filter(visible)
            .map(el => {
              const rect = el.getBoundingClientRect();
              return {
                text: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim().slice(0, 40),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };
            })
            .filter(row => row.width < 43 || row.height < 43);
          return {
            overflow: root.scrollWidth > root.clientWidth + 1,
            tooSmall,
          };
        }""",
        selector,
    )
    assert not result['overflow'], f'{selector} 存在横向溢出'
    assert result['tooSmall'] == [], f'{selector} 存在小于 44×44 的操作区：{result["tooSmall"]}'


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width in (360, 390, 430, 1024):
            context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block')
            page = context.new_page()
            page.set_default_timeout(8_000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(URL)
            page.wait_for_selector('#hm-quick:not([hidden])')

            quick = page.locator('#hm-quick button').evaluate_all(
                "els => els.map(el => ({text: el.textContent.trim(), ...el.getBoundingClientRect().toJSON()}))"
            )
            assert len(quick) == 6
            assert quick[-1]['text'] == '全部'
            assert abs(quick[-1]['top'] - quick[0]['top']) < 1
            assert_usable(page, '#page-home')

            page.click('#btn-search')
            page.wait_for_selector('#sp-search.open')
            assert_usable(page, '#sp-search')
            page.click('#sr-adv-filter')
            page.wait_for_selector('.fp-panel')
            assert_usable(page, '.fp-panel')
            page.click('.fp-cancel')
            page.wait_for_selector('.fp-panel', state='detached')
            page.click('#sr-cancel-btn')
            page.wait_for_selector('#sp-search', state='detached')

            page.click('#hm-quick [data-qa="cal"]')
            page.wait_for_selector('#sp-calendar.open')
            assert_usable(page, '#sp-calendar')
            page.click('#sp-calendar [data-act="back"]')
            page.wait_for_selector('#sp-calendar', state='detached')

            for tab in ('page-acct', 'page-report', 'page-life', 'page-mine'):
                page.click(f'.tab[data-page="{tab}"]')
                page.wait_for_selector(f'#{tab}.is-active')
                assert_usable(page, f'#{tab}')

            for subpage in (
                'sp-reimburse', 'sp-budget', 'sp-loan', 'sp-recurring', 'sp-categories',
                'sp-template-manage', 'sp-tags', 'sp-backup', 'sp-trash', 'sp-ai-inbox', 'sp-settings',
            ):
                page.click(f'#page-mine [data-sub="{subpage}"]')
                page.wait_for_selector(f'#{subpage}.open')
                page.wait_for_timeout(80)
                assert_usable(page, f'#{subpage}')
                if subpage == 'sp-recurring':
                    page.click('#sp-recurring [data-act="new"]')
                    page.wait_for_selector('#sheet.open')
                    assert_usable(page, '#sheet')
                    page.click('#sheet [data-act="close"]')
                    page.wait_for_selector('#sheet.open', state='detached')
                if subpage == 'sp-settings':
                    switches = page.locator('#sp-settings [data-sw^="ntf-"]')
                    assert switches.count() == 2
                    assert switches.evaluate_all('els => els.every(el => !el.disabled)')
                    page.click('#sp-settings [data-sw="ntf-credit"]')
                    page.wait_for_selector('#sp-settings [data-sw="ntf-credit"][aria-checked="true"]')
                    assert page.locator('#sp-settings [data-freq]').count() == 0
                    assert page.locator('#sp-settings [data-sw="ntf-backup"]').count() == 0
                    assert '首页提醒' in page.inner_text('#sp-settings section[aria-label="通知"]')
                    page.screenshot(path=str(OUT / f'settings-{width}.png'))
                page.click(f'#{subpage} .sub-head [data-act="back"]')
                page.wait_for_selector(f'#{subpage}', state='detached')

            page.click('#tab-home')
            page.wait_for_selector('#page-home.is-active')
            assert '备份到期' not in page.inner_text('#hm-reminders')
            assert_usable(page, '#page-home')
            page.screenshot(path=str(OUT / f'home-reminder-{width}.png'))
            assert not errors, errors
            print(f'PASS browser usability {width}', flush=True)
            context.close()
        browser.close()


if __name__ == '__main__':
    main()
