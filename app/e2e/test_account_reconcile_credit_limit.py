"""账户对账可操作、计入收支，以及信用卡剩余额度展示。数据完全虚构。"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/account-reconcile-credit-limit'

SEED = '''async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('GleamDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = db.transaction(['accounts', 'entries'], 'readwrite');
  const now = Date.now();
  tx.objectStore('accounts').clear();
  tx.objectStore('entries').clear();
  tx.objectStore('accounts').put({
    id: 2, name: '虚构信用卡', group: 'credit', balance: -300000,
    hidden: false, countInNetWorth: true, sortOrder: 1,
    billingDay: 20, repayDay: 10, creditReminderEnabled: true,
    createdAt: now, updatedAt: now,
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}'''


def latest_entry(page):
    return page.evaluate('''async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(['accounts', 'entries']);
      const account = await new Promise(resolve => {
        const request = tx.objectStore('accounts').get(2);
        request.onsuccess = () => resolve(request.result);
      });
      const entries = await new Promise(resolve => {
        const request = tx.objectStore('entries').getAll();
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return { account, entry: entries.at(-1) };
    }''')


def run_case(page, width):
    page.goto(URL)
    page.wait_for_selector('#fab')
    page.evaluate(SEED)
    page.reload()
    page.wait_for_selector('#fab')

    page.locator('.tab[data-page="page-acct"]').click()
    page.locator('[data-acct="2"]').click()
    page.locator('#sp-account-detail.open').wait_for()

    page.locator('#sp-account-detail.open [data-account-action="edit"]').click()
    page.locator('#af-limit').fill('10000')
    page.locator('#sheet [data-act="save"]').click()
    page.locator('#sheet.open').wait_for(state='detached')
    page.wait_for_function("document.querySelector('#sp-account-detail')?.textContent.includes('剩余额度')")
    assert '¥7,000.00' in page.locator('#sp-account-detail').inner_text()
    page.screenshot(path=str(OUT / f'credit-detail-{width}.png'), animations='disabled')

    page.locator('#sp-account-detail .sub-head [data-act="back"]').click()
    page.locator('#sp-account-detail').wait_for(state='detached')
    page.locator('[data-acct="2"]').wait_for()
    assert '剩余额度 ¥7,000.00' in page.locator('[data-acct="2"]').inner_text()

    page.locator('[data-acct="2"]').click()
    page.locator('#sp-account-detail.open [data-account-action="reconcile"]').click()
    page.locator('#rc-target').fill('2500')
    page.locator('#sheet [data-act="save"]').click()
    page.locator('#sheet.open').wait_for(state='detached')

    saved = latest_entry(page)
    assert saved['account']['balance'] == -250000
    assert saved['entry']['type'] == 'income'
    assert saved['entry']['amount'] == 50000
    assert saved['entry']['accountId'] == 2
    assert saved['entry']['note'] == '余额对账调整'

    page.locator('#sp-account-detail .sub-head [data-act="back"]').click()
    page.locator('#sp-account-detail').wait_for(state='detached')
    page.wait_for_function("document.querySelector('[data-acct=\"2\"]')?.textContent.includes('¥7,500.00')")
    page.screenshot(path=str(OUT / f'credit-account-{width}.png'), animations='disabled')
    page.locator('.tab[data-page="page-report"]').click()
    page.wait_for_function("document.querySelector('#r-income')?.textContent.includes('500.00')")
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.screenshot(path=str(OUT / f'account-reconcile-credit-{width}.png'), animations='disabled')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width in (360, 390, 430, 1024):
            context = browser.new_context(
                viewport={'width': width, 'height': 844},
                service_workers='block',
            )
            page = context.new_page()
            page.set_default_timeout(7000)
            run_case(page, width)
            print(f'PASS account reconcile and credit limit {width}', flush=True)
            context.close()
        browser.close()


if __name__ == '__main__':
    main()
