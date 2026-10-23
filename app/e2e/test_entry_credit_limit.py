"""付款账户显示当前信用卡额度；仅使用虚构账目。"""
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/entry-credit-limit'
SEED = '''async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('GleamDB');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  const tx = db.transaction(['accounts', 'entries', 'categories'], 'readwrite');
  for (const name of ['accounts', 'entries', 'categories']) tx.objectStore(name).clear();
  const now = Date.now(), stamp = {createdAt: now, updatedAt: now};
  tx.objectStore('categories').put({...stamp, id: 1, name: '饮料水果', kind: 'expense', icon: 'ic-fruit', sortOrder: 1});
  const cases = [
    {}, {creditLimit: undefined}, {group: 'debit'}, {creditLimit: 0},
    {balance: -1000000}, {balance: -1200000}, {balance: 20000},
    {}, {}, {}, {}, {name: '虚构银行 <旅行&生活> 联名白金信用卡', creditLimit: 100000000, balance: -123456},
  ];
  cases.forEach((changes, i) => {
    const id = i + 1;
    tx.objectStore('accounts').put({...stamp, id, name: '1-虚构信用卡', group: 'credit',
      creditLimit: 1000000, balance: -300000, hidden: false, countInNetWorth: true, sortOrder: id, ...changes});
    const variant = id === 8 ? {refundFlag: true} : id === 9 ? {amount: -1759}
      : id === 10 ? {type: 'income'} : id === 11 ? {type: 'transfer', fromAccountId: id, toAccountId: 3} : {};
    tx.objectStore('entries').put({...stamp, id, type: 'expense', amount: 1759, accountId: id,
      categoryId: 1, occurredAt: now - id * 1000, note: '虚构账目', deletedAt: 0, reimburseStatus: 'none', ...variant});
  });
  await new Promise((resolve, reject) => {tx.oncomplete = resolve; tx.onerror = () => reject(tx.error)});
  db.close();
}'''


def check_detail(page, entry_id, expected, screenshot=None):
    page.locator(f'#hm-days [data-entry="{entry_id}"]').click()
    detail = page.locator('#sp-entry-view')
    detail.locator('.entry-view-hero').wait_for()
    account_row = detail.locator('.entry-view-fields').first.locator('.detail-field').nth(1)
    if expected:
        expect(account_row).to_contain_text(expected)
    else:
        expect(account_row).not_to_contain_text('剩余额度')
        expect(account_row).not_to_contain_text('已超额')
    assert account_row.evaluate('''row => {
      const label = row.firstElementChild.getBoundingClientRect();
      const value = row.lastElementChild.getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      return label.right + 8 <= value.left && value.right <= bounds.right + 1
        && row.scrollWidth <= row.clientWidth + 1;
    }'''), account_row.inner_text()
    if screenshot:
        page.screenshot(path=str(OUT / screenshot), animations='disabled')
    detail.locator('.sub-head [data-act="back"]').click()
    detail.wait_for(state='detached')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for width, theme, scale in [(360, 'light', 1), (390, 'light', 1), (430, 'light', 1),
                                     (1280, 'light', 1), (360, 'dark', 1.3)]:
            context = browser.new_context(viewport={'width': width, 'height': 890}, service_workers='block')
            external, errors = [], []
            context.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(URL).netloc
                          else (external.append(r.request.url), r.abort()))
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(URL)
            page.locator('#fab').wait_for()
            page.evaluate(SEED)
            page.reload()
            page.locator('#fab').wait_for()
            page.evaluate('''([theme, scale]) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.style.setProperty('--seed-type', String(scale));
            }''', [theme, scale])
            label = f'{width}-{theme}'
            check_detail(page, 1, '剩余额度 ¥7,000.00', f'normal-{label}.png')
            if width == 360 and theme == 'light':
                for entry_id in (2, 3, 4, 8, 9, 10, 11):
                    check_detail(page, entry_id, None)
                check_detail(page, 5, '剩余额度 ¥0.00')
                check_detail(page, 6, '已超额 ¥2,000.00', 'over-limit.png')
                check_detail(page, 7, '剩余额度 ¥10,200.00')
                # 退款回到原详情时，额度应随当前账户余额更新。
                page.locator('#hm-days [data-entry="1"]').click()
                page.locator('#sp-entry-view [data-view-action="refund"]').click()
                page.locator('#rf-keypad [data-rk="clear"]').click()
                page.locator('#rf-keypad [data-rk="5"]').click()
                page.locator('#rf-keypad [data-rk="save"]').click()
                page.locator('#sp-entry-refund').wait_for(state='detached')
                expect(page.locator('#sp-entry-view .entry-view-credit')).to_have_text('剩余额度 ¥7,005.00')
                page.locator('#sp-entry-view .sub-head [data-act="back"]').click()
                page.locator('#sp-entry-view').wait_for(state='detached')
            check_detail(page, 12, '剩余额度 ¥998,765.44', f'long-{label}.png')
            assert not errors, errors
            assert not external, external
            print(f'PASS entry credit limit {label} text scale {scale}', flush=True)
            context.close()
        browser.close()


if __name__ == '__main__':
    main()
