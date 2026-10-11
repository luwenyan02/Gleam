"""七日消费节奏：虚构账目、同口径下钻、首页配置和窄屏。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_stats_safety import seed

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/spending-rhythm'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1024):
            context = browser.new_context(viewport={'width': width, 'height': 844},
                                          timezone_id='America/New_York', service_workers='block')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(URL)
            page.locator('#fab').wait_for()
            seed(page, [])
            card = page.locator('#hm-rhythm')
            expect(card).to_be_visible()
            expect(card).not_to_have_attribute('open', '')
            expect(page.locator('#rhythm-meta')).to_have_text('这 7 天还没有支出记录')
            accessible = card.locator('summary').aria_snapshot()
            assert '最近 7 天' in accessible and '净支出' in accessible, accessible
            card.locator('summary').click()
            expect(card.locator('.rhythm-day')).to_have_count(7)
            expect(card.locator('.rhythm-count').first).to_have_text('无记录')

            timestamps = page.evaluate('''() => {
              const d = new Date();
              return Array.from({length: 7}, (_, i) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6 + i, 12).getTime());
            }''')
            entries = [
                {'id': 1, 'type': 'expense', 'amount': 1000, 'occurredAt': timestamps[0], 'accountId': 1, 'categoryId': 1},
                {'id': 2, 'type': 'expense', 'amount': 333, 'refundFlag': True, 'occurredAt': timestamps[1], 'accountId': 1, 'categoryId': 1},
                {'id': 3, 'type': 'income', 'amount': 999999, 'occurredAt': timestamps[2], 'accountId': 1},
                {'id': 4, 'type': 'expense', 'amount': 2000, 'occurredAt': timestamps[3], 'accountId': 1, 'categoryId': 1,
                 'reimburseStatus': 'done', 'reimbursedAmount': 1500, 'reimbursedAt': timestamps[6], 'reimburseAccountId': 1},
                {'id': 5, 'type': 'transfer', 'amount': 999999, 'occurredAt': timestamps[4], 'fromAccountId': 1, 'toAccountId': 2},
                {'id': 6, 'type': 'loan', 'amount': 999999, 'occurredAt': timestamps[4], 'fromAccountId': 1, 'toAccountId': 2},
            ]
            seed(page, entries)
            expect(page.locator('#rhythm-total')).to_contain_text('11.67')
            expect(page.locator('#rhythm-meta')).to_contain_text('有支出记录 2 天')
            card.locator('summary').click()
            expect(card.locator('.rhythm-amount').nth(1)).to_have_text('-3.33')
            expect(card.locator('.rhythm-amount').nth(3)).to_have_text('5.00')
            # Exact daily expense filter, with refund sign preserved and focus returned.
            day = card.locator('.rhythm-day').nth(1)
            day.click()
            expect(page.locator('#sr-results [data-eid]')).to_have_count(1)
            expect(page.locator('#sr-results [data-eid="2"]')).to_be_visible()
            expect(page.locator('#sr-results [data-sf="expense"]')).to_contain_text('-3.33')
            page.locator('#sp-search [data-act="back"]').click()
            expect(page.locator('#sp-search')).to_have_count(0)
            expect(card).to_have_attribute('open', '')
            expect(day).to_be_focused()
            # Repeated navigation remains single-layer and preserves the expanded card.
            day.click()
            expect(page.locator('#sp-search')).to_have_count(1)
            page.go_back()
            expect(page.locator('#sp-search')).to_have_count(0)
            expect(card).to_have_attribute('open', '')
            # Existing settings can hide and restore the new module.
            page.locator('#btn-home-edit').click()
            toggle = page.locator('[data-sw="rhythm"]')
            toggle.click()
            expect(toggle).to_have_attribute('aria-checked', 'false')
            page.locator('#sp-home-custom [data-act="back"]').click()
            expect(card).to_be_hidden()
            page.locator('#btn-home-edit').click()
            page.locator('[data-sw="rhythm"]').click()
            expect(page.locator('[data-sw="rhythm"]')).to_have_attribute('aria-checked', 'true')
            page.locator('#sp-home-custom [data-act="back"]').click()
            expect(card).to_be_visible()
            page.reload()
            expect(card).to_be_visible()
            # Large daily and total amounts cannot overlap adjacent day cells.
            entries[0]['amount'] = 99999999999
            seed(page, entries)
            card.locator('summary').click()
            expect(card.locator('.rhythm-day')).to_have_count(7)
            expect(card.locator('.rhythm-amount').first).to_have_text('999,999,999.99')
            dimensions = card.locator('.rhythm-day').evaluate_all('''buttons => buttons.map(button => {
              const amount = button.querySelector('.rhythm-amount');
              const rect = button.getBoundingClientRect(); const value = amount.getBoundingClientRect();
              return {width: rect.width, height: rect.height, contained: value.left >= rect.left && value.right <= rect.right,
                noTextOverflow: amount.scrollWidth <= amount.clientWidth + 1};
            })''')
            assert len(dimensions) == 7, dimensions
            assert all(d['width'] >= 44 and d['height'] >= 44 and d['contained'] and d['noTextOverflow'] for d in dimensions), dimensions
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            page.screenshot(path=str(OUT / f'rhythm-{width}.png'))
            assert not errors, errors
            print(f'PASS spending rhythm, exact drill-down, settings and long amounts {width}', flush=True)
            context.close()
        browser.close()


if __name__ == '__main__':
    main()
