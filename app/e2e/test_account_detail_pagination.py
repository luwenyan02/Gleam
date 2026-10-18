"""Appending a long month preserves nodes, focus, balances and live refresh."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_account_detail_performance import URL, SEED

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/account-detail-pagination'

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360,390,430,1280):
            context = browser.new_context(viewport={'width':width,'height':890}, service_workers='block')
            page = context.new_page()
            page.goto(URL)
            page.locator('#fab').wait_for()
            # A single long month; every record is fictional and each amount is one yuan.
            seed = SEED.replace('id<=20000','id<=185').replace('id<=(dense?2000:20)','id<=185')
            page.evaluate(seed, True)
            page.reload()
            page.locator('#fab').wait_for()
            page.locator('[data-page="page-acct"]').click()
            page.locator('[data-acct="1"]').click()
            detail = page.locator('#sp-account-detail')
            rows = detail.locator('.account-month-entries [data-eid]')
            more = detail.locator('[data-account-more-entries]')
            expect(rows).to_have_count(80)
            expect(more).to_contain_text('80 / 185')
            page.evaluate('window.__firstAccountRow=document.querySelector(".account-month-entries [data-eid]")')
            more.click()
            expect(rows).to_have_count(160)
            expect(more).to_contain_text('160 / 185')
            assert page.evaluate('window.__firstAccountRow.isConnected')
            assert more.evaluate('el=>el===document.activeElement')
            more.scroll_into_view_if_needed()
            expect(more).to_be_in_viewport()
            assert more.bounding_box()['height'] >= 44
            box = more.bounding_box()
            footer = detail.locator('.account-detail-footer').bounding_box()
            assert box['y'] + box['height'] <= footer['y'] + 1
            assert detail.evaluate('el=>el.scrollWidth<=el.clientWidth+1')
            page.screenshot(path=str(OUT/f'more-{width}.png'), animations='disabled')
            more.press('Enter')
            expect(rows).to_have_count(185)
            expect(more).to_have_count(0)
            assert detail.locator('[data-eid="161"] .entry-swipe-content').evaluate('el=>el===document.activeElement')
            expect(detail.locator('[data-eid="185"] .account-entry-balance')).to_contain_text('10,184.00')
            detail.locator('[data-eid="185"] .entry-swipe-content').click()
            entry = page.locator('#sp-entry-view')
            entry.locator('.entry-view-hero').wait_for()
            entry.locator('.sub-head [data-act="back"]').click()
            entry.wait_for(state='detached')
            expect(rows).to_have_count(185)
            # A normal save must invalidate the cached snapshot, including balance and totals.
            detail.locator('.account-detail-entry').click()
            page.locator('#keypad [data-k="1"]').click()
            page.locator('#keypad [data-k="save"]').click()
            page.locator('#sheet.open').wait_for(state='detached')
            expect(rows).to_have_count(186)
            expect(detail.locator('.account-current-balance')).to_contain_text('9,999.00')
            expect(detail.locator('.account-flow-total')).to_contain_text('186.00')
            detail.locator('.sub-head [data-act="back"]').click()
            detail.wait_for(state='detached')
            expect(page.locator('[data-acct="1"]')).to_contain_text('9,999.00')
            page.locator('[data-acct="1"]').click()
            expect(page.locator('#sp-account-detail .account-month-entries [data-eid]')).to_have_count(80)
            context.close()
            print('PASS full month pagination and live snapshot refresh', width, flush=True)
        browser.close()
