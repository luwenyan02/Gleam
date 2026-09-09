"""日历当日明细、筛选联动与返回保留状态，隔离虚构数据四屏宽回归。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/calendar-daylist'

SEED = '''async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = db.transaction(['accounts', 'entries', 'categories'], 'readwrite');
  const now = Date.now();
  const day = new Date(); day.setHours(12, 0, 0, 0);
  const a = tx.objectStore('accounts'); const c = tx.objectStore('categories'); const e = tx.objectStore('entries');
  a.clear(); c.clear(); e.clear();
  a.put({ id: 1, name: '虚构现金', group: 'cash', balance: 8766, hidden: false, countInNetWorth: true, sortOrder: 1, createdAt: now, updatedAt: now });
  c.put({ id: 1, name: '虚构餐饮', icon: 'ic-bowl', kind: 'expense', sortOrder: 1, createdAt: now, updatedAt: now });
  e.put({ id: 1, type: 'expense', amount: 1234, occurredAt: day.getTime(), categoryId: 1, accountId: 1, note: '虚构午餐', reimburseStatus: 'none', deletedAt: 0, createdAt: now, updatedAt: now });
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
            page.get_by_text('日历', exact=True).last.click()
            page.wait_for_selector('#sp-calendar.open')
            page.wait_for_selector('#sp-calendar .cal-day.sel')
            assert '虚构餐饮' in page.inner_text('#sp-calendar')
            page.click('#sp-calendar [data-act="filter"]')
            page.wait_for_selector('.fp-panel')
            page.click('.fp-panel [data-expand="category"]')
            page.wait_for_selector('#fp-cats:not([hidden])')
            page.click('#fp-cats [data-cid]')
            page.click('.fp-ok')
            page.wait_for_selector('.fp-panel', state='detached')
            assert '筛选中' in page.inner_text('#sp-calendar')
            assert '虚构餐饮' in page.inner_text('#sp-calendar')
            page.click('#sp-calendar [data-eid]')
            page.wait_for_selector('#sp-entry-view.open')
            page.click('#sp-entry-view .sub-head [data-act="back"]')
            page.wait_for_selector('#sp-entry-view', state='detached')
            assert '筛选中' in page.inner_text('#sp-calendar')
            page.wait_for_timeout(400)
            page.screenshot(path=str(OUT / f'daylist-{width}.png'))
            assert not errors, errors
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            print(f'PASS calendar day list, filter, back state {width}', flush=True)
            ctx.close()
        browser.close()
if __name__ == '__main__': main()
