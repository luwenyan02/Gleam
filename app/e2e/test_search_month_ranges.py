"""整月搜索：日期显示、汇总和批量修改使用相同边界（全部为虚构数据）。"""
import calendar
import os
from datetime import datetime
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).resolve().parents[2] / '.tmp/tests/e2e/search-month-ranges'


def seed(page):
    return page.evaluate("""async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const now = new Date();
      const y = now.getFullYear(); const m = now.getMonth();
      const tx = db.transaction(['categories', 'accounts', 'entries', 'settings'], 'readwrite');
      const stamp = { createdAt: now.getTime(), updatedAt: now.getTime() };
      const categories = tx.objectStore('categories'); const entries = tx.objectStore('entries');
      const accounts = tx.objectStore('accounts');
      categories.clear(); entries.clear(); accounts.clear();
      categories.put({ id: 910001, kind: 'expense', name: '虚构日期原分类', icon: 'ic-bowl', sortOrder: 1, ...stamp });
      categories.put({ id: 910002, kind: 'expense', name: '虚构日期目标分类', icon: 'ic-car', sortOrder: 2, ...stamp });
      accounts.put({ id: 910001, name: '虚构日期账户', group: 'cash', balance: -15000, hidden: false, countInNetWorth: true, sortOrder: 1, ...stamp });
      const dates = [
        new Date(y, m - 2, 1), new Date(y, m, 1),
        new Date(y, m + 1, 1).getTime() - 1,
        new Date(y, m + 1, 1), new Date(y, m - 2, 1).getTime() - 1,
      ];
      dates.forEach((date, index) => entries.put({
        id: 910001 + index, type: 'expense', amount: (index + 1) * 1000,
        occurredAt: Number(date), accountId: 910001, categoryId: 910001,
        note: '虚构月范围边界', reimburseStatus: 'none', deletedAt: 0, ...stamp,
      }));
      tx.objectStore('settings').put({ key: 'accounting.monthStartDay', value: 28, updatedAt: now.getTime() });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      db.close();
    }""")


def entry_ids(page):
    return sorted(page.locator('#sr-results [data-eid]').evaluate_all('els => els.map(el => Number(el.dataset.eid))'))


def run_case(browser, width, year, month):
    context = browser.new_context(viewport={'width': width, 'height': 844}, timezone_id='Asia/Shanghai', service_workers='block')
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(URL) else route.abort())
    page = context.new_page()
    # Ignore Vite HMR when this targeted regression is run against a development server.
    page.route_web_socket('**/*', lambda socket: socket.connect_to_server().on_message(lambda _message: None))
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.set_fixed_time(datetime.fromisoformat(f'{year}-{month:02d}-18T12:00:00+08:00'))
    page.goto(URL)
    page.wait_for_selector('#hm-quick')
    seed(page)
    page.click('#btn-search')
    page.wait_for_selector('#sp-search.open')
    page.click('#sr-dates [data-range="month"]')
    expect(page.locator('#sr-date-from')).to_have_text(f'{year}/{month:02d}/01 ▾')
    last = calendar.monthrange(year, month)[1]
    expect(page.locator('#sr-date-to')).to_have_text(f'{year}/{month:02d}/{last} ▾')
    expect(page.locator('#sr-results [data-sf="expense"] .sc-amount')).to_have_text('50.00')
    assert entry_ids(page) == [910002, 910003]
    page.click('#sr-batch')
    expect(page.locator('#sr-batch-count')).to_have_text('已选 2 / 2 笔')
    page.click('#sr-batch')
    page.click('#sr-dates [data-range="3m"]')
    start = datetime(year - (month <= 2), (month - 3) % 12 + 1, 1)
    expect(page.locator('#sr-date-from')).to_have_text(start.strftime('%Y/%m/%d') + ' ▾')
    expect(page.locator('#sr-date-to')).to_have_text(f'{year}/{month:02d}/{last} ▾')
    expect(page.locator('#sr-results [data-sf="expense"] .sc-amount')).to_have_text('60.00')
    assert entry_ids(page) == [910001, 910002, 910003]
    page.click('#sr-batch')
    expect(page.locator('#sr-batch-count')).to_have_text('已选 3 / 3 笔')
    page.click('#sp-search [data-batch-act="category"]')
    page.click('#sheet [data-pick="910002"]')
    page.get_by_role('alertdialog').get_by_role('button', name='修改', exact=True).click()
    expect(page.locator('#sheet')).not_to_be_visible()
    expect(page.locator('#sr-results [data-sf="expense"] .sc-amount')).to_have_text('60.00')
    page.wait_for_function("""async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction('entries'); const r = tx.objectStore('entries').getAll();
      const rows = await new Promise(resolve => { r.onsuccess = () => resolve(r.result); }); db.close();
      return rows.filter(e => e.categoryId === 910002).length === 3;
    }""")
    categories = page.evaluate("""async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result); });
      const r = db.transaction('entries').objectStore('entries').getAll();
      const rows = await new Promise(resolve => { r.onsuccess = () => resolve(r.result); }); db.close();
      return rows.map(e => [e.id, e.categoryId]);
    }""")
    assert dict(categories) == {910001: 910002, 910002: 910002, 910003: 910002, 910004: 910001, 910005: 910001}
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    assert not errors, errors
    page.screenshot(path=str(OUT / f'{year}-{month:02d}-{width}.png'), animations='disabled')
    print(f'PASS search full-month display, summary and batch boundaries {year}-{month:02d} {width}', flush=True)
    context.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for width in (360, 390, 430, 1280):
            run_case(browser, width, 2026, 10)
        for year, month in ((2028, 2), (2026, 1)):
            run_case(browser, 390, year, month)
        browser.close()


if __name__ == '__main__':
    main()
