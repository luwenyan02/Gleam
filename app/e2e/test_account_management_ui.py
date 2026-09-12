"""账户详情紧凑布局与集中管理页。测试数据完全虚构。"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/account-management-ui'

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
  const rows = [
    { id: 1, name: '虚构现金甲', group: 'cash', balance: 10000, sortOrder: 1 },
    { id: 2, name: '虚构现金乙', group: 'cash', balance: 20000, sortOrder: 2 },
    { id: 3, name: '虚构信用卡', group: 'credit', balance: -30979, creditLimit: 1000000,
      billingDay: 20, repayDay: 10, sortOrder: 1 },
    { id: 4, name: '虚构空账户', group: 'online', balance: 0, sortOrder: 1 },
  ];
  for (const row of rows) tx.objectStore('accounts').put({
    ...row, hidden: false, countInNetWorth: true, createdAt: now, updatedAt: now,
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}'''


def account(page, account_id):
    return page.evaluate('''async (id) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = await new Promise(resolve => {
        const request = db.transaction('accounts').objectStore('accounts').get(id);
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return value;
    }''', account_id)


def run_case(page, width):
    page.goto(URL)
    page.wait_for_selector('#fab')
    page.evaluate(SEED)
    page.reload()
    page.wait_for_selector('#fab')
    page.locator('.tab[data-page="page-acct"]').click()

    page.locator('[data-acct="3"]').click()
    page.locator('#sp-account-detail.open').wait_for()
    side = page.locator('.credit-limit-side')
    side.wait_for()
    side_text = ' '.join(side.inner_text().split())
    assert '信用额度 ¥10,000.00' in side_text
    assert '剩余额度 ¥9,690.21' in side_text
    assert page.locator('[data-account-action="up"], [data-account-action="down"], [data-account-action="networth"], [data-account-action="hide"]').count() == 0
    assert page.locator('.account-detail-actions button').count() == 2
    assert page.locator('.account-detail-actions').bounding_box()['height'] <= 56
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.screenshot(path=str(OUT / f'account-detail-{width}.png'), animations='disabled')

    page.locator('#sp-account-detail .sub-head [data-act="back"]').click()
    page.locator('[data-account-manage]').click()
    page.locator('#sp-account-manage.open').wait_for()
    cash_rows = page.locator('[data-manage-group="cash"] [data-manage-account]')
    assert cash_rows.count() == 2
    assert cash_rows.nth(0).get_attribute('data-manage-account') == '1'
    page.locator('[data-manage-account="2"] [data-move="up"]').click()
    page.wait_for_function("document.querySelector('[data-manage-group=\"cash\"] [data-manage-account]')?.dataset.manageAccount === '2'")

    page.locator('[data-manage-account="3"] [data-account-settings]').click()
    page.locator('#sheet [data-manage-action="networth"]').click()
    page.wait_for_function("document.querySelector('[data-manage-account=\"3\"]')?.textContent.includes('不计入净资产')")
    assert account(page, 3)['countInNetWorth'] is False

    page.locator('[data-manage-account="3"] [data-account-settings]').click()
    page.locator('#sheet [data-manage-action="edit"]').click()
    page.locator('#af-name').wait_for()
    assert page.locator('#af-name').input_value() == '虚构信用卡'
    page.locator('#sheet [data-act="close"]').click()

    page.locator('[data-manage-account="3"] [data-account-settings]').click()
    page.locator('#sheet [data-manage-action="visibility"]').click()
    page.locator('#dialog-scrim.show [data-act="ok"]').click()
    page.wait_for_function("document.querySelector('[data-manage-account=\"3\"]')?.textContent.includes('已隐藏')")
    assert account(page, 3)['hidden'] is True

    page.locator('[data-manage-account="3"] [data-account-settings]').click()
    page.locator('#sheet [data-manage-action="visibility"]').click()
    page.wait_for_function("document.querySelector('[data-manage-account=\"3\"]')?.textContent.includes('显示中')")
    assert account(page, 3)['hidden'] is False
    page.locator('[data-manage-account="3"] [data-account-settings]').click()
    page.locator('#sheet [data-manage-action="visibility"]').click()
    page.locator('#dialog-scrim.show [data-act="ok"]').click()
    page.wait_for_function("document.querySelector('[data-manage-account=\"3\"]')?.textContent.includes('已隐藏')")

    page.locator('[data-manage-account="4"] [data-account-settings]').click()
    page.locator('#sheet [data-manage-action="delete"]').click()
    page.locator('#dialog-scrim.show [data-act="ok"]').click()
    page.wait_for_function("!document.querySelector('[data-manage-account=\"4\"]')")
    assert account(page, 4) is None
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.screenshot(path=str(OUT / f'account-manage-{width}.png'), animations='disabled')

    page.locator('#sp-account-manage .sub-head [data-act="back"]').click()
    page.wait_for_selector('#sp-account-manage', state='detached')
    assert page.locator('[data-acct="3"]').count() == 0


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width in (360, 390, 430, 1024):
            context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block')
            page = context.new_page()
            page.set_default_timeout(7000)
            run_case(page, width)
            print(f'PASS account management layout {width}', flush=True)
            context.close()
        browser.close()


if __name__ == '__main__':
    main()
