"""信用卡每期账单与分次还款闭环，隔离虚构数据四屏宽回归。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/credit-statements'

SEED = '''async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction(['accounts', 'entries', 'settings'], 'readwrite');
  const now = Date.now();
  const a = tx.objectStore('accounts');
  a.clear();
  a.put({ id: 1, name: '虚构现金', group: 'cash', balance: 10000, hidden: false, countInNetWorth: true, sortOrder: 1, createdAt: now, updatedAt: now });
  a.put({ id: 2, name: '虚构信用卡', group: 'credit', balance: -3000, hidden: false, countInNetWorth: true, sortOrder: 2, billingDay: 20, repayDay: 10, creditReminderEnabled: true, createdAt: now, updatedAt: now });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
}'''

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
            page.evaluate(SEED)
            page.reload()
            page.wait_for_selector('#hm-quick')
            page.click('#hm-quick .hm-all')
            page.get_by_text('信用卡', exact=True).last.click()
            page.wait_for_selector('#sp-credit.open')
            page.click('#sp-credit [data-act="add"]')
            page.fill('#cr-due-amt', '30')
            page.click('#sheet [data-act="save"]')
            page.wait_for_selector('#sp-credit .cr-stmt')
            assert '应还' in page.inner_text('#sp-credit')
            page.click('#sp-credit [data-act="pay"]')
            page.fill('#cr-amount', '10')
            page.click('#sheet [data-act="save"]')
            page.wait_for_selector('#sheet.open', state='detached')
            page.wait_for_function("document.querySelector('#sp-credit')?.textContent.includes('20.00')")
            page.click('#sp-credit [data-act="pay"]')
            page.fill('#cr-amount', '20')
            page.click('#sheet [data-act="save"]')
            page.wait_for_selector('#sheet.open', state='detached')
            page.wait_for_function("document.querySelector('#sp-credit')?.textContent.includes('已还清')")
            page.wait_for_timeout(400)
            page.screenshot(path=str(OUT / f'statements-{width}.png'))
            assert not errors, errors
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            print(f'PASS credit statements split repayment {width}', flush=True)
            ctx.close()
        browser.close()
if __name__ == '__main__': main()
