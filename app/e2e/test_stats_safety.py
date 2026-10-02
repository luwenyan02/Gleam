"""统计、报销事件和预算并发的浏览器回归；所有数据均为虚构数据。"""
import os
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
SHOTS = Path(os.environ.get(
    'GLEAM_E2E_SCREENSHOTS',
    Path(__file__).parents[2] / '.tmp/tests/e2e/stats-safety',
))
SHOTS.mkdir(parents=True, exist_ok=True)


def seed(page, entries, count_as_income=False, previous_budget=False):
    page.evaluate('''async fixture => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const stores = ['entries', 'accounts', 'categories', 'settings', 'budgets', 'categoryBudgets'];
      const tx = db.transaction(stores, 'readwrite');
      const now = Date.now();
      for (const name of stores) tx.objectStore(name).clear();
      tx.objectStore('accounts').put({
        id: 1, name: '虚构现金', group: 'cash', balance: 100000,
        hidden: false, countInNetWorth: true, sortOrder: 1, createdAt: now, updatedAt: now,
      });
      tx.objectStore('categories').put({
        id: 1, name: '虚构餐饮', icon: 'ic-bowl', kind: 'expense', sortOrder: 1,
        createdAt: now, updatedAt: now,
      });
      for (const entry of fixture.entries) {
        tx.objectStore('entries').put({
          reimburseStatus: 'none', deletedAt: 0, createdAt: now, updatedAt: now, ...entry,
        });
      }
      tx.objectStore('settings').put({
        key: 'reimburse.countAsIncome', value: fixture.countAsIncome, updatedAt: now,
      });
      tx.objectStore('settings').put({ key: 'app.seeded', value: true, updatedAt: now });
      if (fixture.previousBudget) {
        const current = new Date();
        const previous = new Date(current.getFullYear(), current.getMonth() - 1, 1);
        const month = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
        tx.objectStore('budgets').put({
          id: 1, month, totalLimit: 100000, autoRenew: true, createdAt: now, updatedAt: now,
        });
        tx.objectStore('categoryBudgets').put({
          id: 1, month, categoryId: 1, limit: 40000, createdAt: now, updatedAt: now,
        });
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }''', {
        'entries': entries,
        'countAsIncome': count_as_income,
        'previousBudget': previous_budget,
    })
    page.reload()
    page.locator('#fab').wait_for()


def day_at(page, day):
    return page.evaluate('''day => {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), day, 12, 0, 0, 0).getTime();
    }''', day)


def offset_consistency(page):
    today = page.evaluate('''() => {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0).getTime();
    }''')
    seed(page, [{
        'id': 1, 'type': 'expense', 'amount': 10000, 'occurredAt': today,
        'categoryId': 1, 'accountId': 1, 'reimburseStatus': 'done',
        'reimbursedAmount': 6000, 'reimbursedAt': today, 'reimburseAccountId': 1,
    }])

    page.wait_for_function("document.querySelector('#m-spend')?.textContent === '40.00'")
    assert '支出 ¥40.00' in page.locator('#hm-today .day-sum').inner_text()

    page.locator('[data-qa="cal"]').click()
    page.locator('#sp-calendar .cd-sum').wait_for()
    assert '-¥40.00' in page.locator('#sp-calendar .cd-sum').inner_text()
    page.locator('#sp-calendar .sub-head [data-act="back"]').click()

    page.locator('.tab[data-page="page-life"]').click()
    page.wait_for_function("document.querySelector('#lf-today-sum')?.textContent.includes('40.00')")
    assert '今天共花了 ¥40.00' in page.locator('#lf-today-sum').inner_text()
    page.screenshot(path=str(SHOTS / f'offset-consistency-{page.viewport_size["width"]}.png'))


def income_event_cross_month(page):
    now = page.evaluate('''() => {
      const now = new Date();
      return {
        old: new Date(now.getFullYear(), now.getMonth() - 1, 3, 12, 0, 0, 0).getTime(),
        received: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0).getTime(),
      };
    }''')
    seed(page, [{
        'id': 1, 'type': 'expense', 'amount': 10000, 'occurredAt': now['old'],
        'categoryId': 1, 'accountId': 1, 'reimburseStatus': 'done',
        'reimbursedAmount': 6000, 'reimbursedAt': now['received'], 'reimburseAccountId': 1,
    }], count_as_income=True)

    page.wait_for_timeout(600)
    income_text = page.locator('#m-income').inner_text()
    assert income_text == '60.00', f'本月收入实际为 {income_text!r}'
    assert '收入 ¥60.00' in page.locator('#hm-today .day-sum').inner_text()
    assert '报销到账' in page.locator('#hm-today').inner_text()
    reimbursement = page.locator('#hm-today [data-reimbursement]')
    assert reimbursement.count() == 1
    assert reimbursement.locator('[data-entry-action]').count() == 0
    assert reimbursement.get_attribute('class') != 'entry-swipe'
    reimbursement.locator('.entry-swipe-content').click()
    page.locator('#sp-entry-view.open').wait_for()
    page.locator('#sp-entry-view .sub-head [data-act="back"]').click()

    page.locator('[data-qa="cal"]').click()
    page.locator('#sp-calendar .cd-sum').wait_for()
    assert '+¥60.00' in page.locator('#sp-calendar .cd-sum').inner_text()
    page.screenshot(path=str(SHOTS / f'income-event-{page.viewport_size["width"]}.png'))


def signed_refund_trend(page):
    positive_at = day_at(page, 1)
    negative_at = day_at(page, 8)
    seed(page, [{
        'id': 1, 'type': 'expense', 'amount': 5000, 'occurredAt': negative_at,
        'categoryId': 1, 'accountId': 1, 'refundFlag': True,
    }])
    page.locator('.tab[data-page="page-report"]').click()
    page.locator('#trend svg').wait_for()
    only_refund = page.locator('#trend rect[data-series="expense"][data-value="-5000"]')
    assert only_refund.count() == 1
    assert page.locator('#r-spend').inner_text() == '-¥50.00'
    assert page.locator('#trend .chart-empty').count() == 0
    assert only_refund.evaluate('e => Number(e.getAttribute("y")) >= Number(e.dataset.zeroY)')

    seed(page, [
        {
            'id': 1, 'type': 'expense', 'amount': 10000, 'occurredAt': positive_at,
            'categoryId': 1, 'accountId': 1,
        },
        {
            'id': 2, 'type': 'expense', 'amount': 15000, 'occurredAt': negative_at,
            'categoryId': 1, 'accountId': 1, 'refundFlag': True, 'refundOfEntryId': 1,
        },
    ])
    page.locator('.tab[data-page="page-report"]').click()
    page.locator('#trend svg').wait_for()

    positive = page.locator('#trend rect[data-series="expense"][data-value="10000"]')
    negative = page.locator('#trend rect[data-series="expense"][data-value="-15000"]')
    assert positive.count() == 1 and negative.count() == 1
    assert positive.evaluate('e => Number(e.getAttribute("y")) < Number(e.dataset.zeroY)')
    assert negative.evaluate('e => Number(e.getAttribute("y")) >= Number(e.dataset.zeroY)')
    assert negative.locator('xpath=..').get_attribute('data-drill-from')
    page.wait_for_timeout(450)
    page.screenshot(path=str(SHOTS / f'signed-refund-trend-{page.viewport_size["width"]}.png'))
    negative.locator('xpath=..').click()
    page.locator('#sp-search.open').wait_for()


def budget_first_open_is_idempotent(page):
    seed(page, [], previous_budget=True)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.locator('.tab[data-page="page-mine"]').click()
    page.get_by_role('button', name='预算中心', exact=False).click()
    page.locator('#sp-budget .budget-overview').wait_for()
    page.wait_for_timeout(400)

    counts = page.evaluate('''async () => {
      const db = await new Promise(resolve => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
      });
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const tx = db.transaction(['budgets', 'categoryBudgets']);
      const all = name => new Promise(resolve => {
        const request = tx.objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
      });
      const [budgets, categories] = await Promise.all([all('budgets'), all('categoryBudgets')]);
      db.close();
      return [
        budgets.filter(row => row.month === month).length,
        categories.filter(row => row.month === month && row.categoryId === 1).length,
      ];
    }''')
    assert counts == [1, 1]
    assert not any('ConstraintError' in error for error in errors), errors


def calendar_refund_direction(page):
    refund_at = day_at(page, 1)
    seed(page, [{
        'id': 1, 'type': 'expense', 'amount': 5000, 'occurredAt': refund_at,
        'categoryId': 1, 'accountId': 1, 'refundFlag': True,
    }])
    page.locator('[data-qa="cal"]').click()
    page.locator('#sp-calendar .cal-grid').wait_for()

    cell = page.locator('#sp-calendar .cal-day[data-d="1"]')
    refund_mark = cell.locator('.cd-amt.refund')
    assert refund_mark.inner_text() == '+50'
    assert '退款净流入' in (refund_mark.get_attribute('aria-label') or '')

    page.locator('#sp-calendar [data-m="heat"]').click()
    page.wait_for_function("document.querySelector('#sp-calendar [data-m=heat]')?.classList.contains('active')")
    heat_style = cell.get_attribute('style') or ''
    assert '-%' not in heat_style, heat_style

    page.locator('#sp-calendar [data-m="std"]').click()
    cell.click()
    page.wait_for_function("document.querySelector('#sp-calendar .cd-sum')?.textContent.includes('-¥50.00')")
    detail = page.locator('#sp-calendar .cd-sum').inner_text()
    assert '净支出' in detail and '-¥-50.00' not in detail
    page.screenshot(path=str(SHOTS / 'calendar-refund-direction-390.png'))


def calendar_picker_layered_back(page):
    seed(page, [])
    page.locator('[data-qa="cal"]').click()
    page.locator('#sp-calendar .cal-title').wait_for()

    page.locator('#sp-calendar .cal-title').click()
    page.locator('#sp-calendar .ym-mask').wait_for()
    page.go_back()
    page.locator('#sp-calendar .ym-mask').wait_for(state='detached')
    assert page.locator('#sp-calendar.open').count() == 1, '浏览器返回误关了日历页'

    page.locator('#sp-calendar .cal-title').click()
    page.locator('#sp-calendar .ym-mask').wait_for()
    page.evaluate("document.dispatchEvent(new CustomEvent('gleam:system-back'))")
    page.locator('#sp-calendar .ym-mask').wait_for(state='detached')
    assert page.locator('#sp-calendar.open').count() == 1, '系统返回误关了日历页'

    page.locator('#sp-calendar .cal-title').click()
    page.locator('#sp-calendar .ym-mask [data-mo].sel').click()
    page.locator('#sp-calendar .ym-mask').wait_for(state='detached')
    page.wait_for_function("!history.state?.gleamLayer")

    page.locator('#sp-calendar .cal-title').click()
    page.locator('#sp-calendar .ym-mask').click(position={'x': 4, 'y': 4})
    page.locator('#sp-calendar .ym-mask').wait_for(state='detached')
    page.wait_for_function("!history.state?.gleamLayer")


def home_dense_single_day_page(page):
    dates = page.evaluate('''() => {
      const now = new Date();
      return {
        current: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0).getTime(),
        older: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0, 0).getTime(),
      };
    }''')
    entries = [{
        'id': index + 1,
        'type': 'expense',
        'amount': 100,
        'occurredAt': dates['current'],
        'categoryId': 1,
        'accountId': 1,
        'note': f'虚构同日流水{index + 1}',
    } for index in range(60)]
    seed(page, entries)

    page.wait_for_function("document.querySelectorAll('#hm-today [data-entry-row]').length === 60")
    assert page.locator('#hm-today .home-empty').count() == 0
    assert '¥60.00' in page.locator('#hm-today .day-sum').inner_text()
    assert page.locator('#hm-more').inner_text() == '已展示全部流水'

    page.locator('#page-home').evaluate('element => { element.scrollTop = element.scrollHeight; }')
    page.wait_for_timeout(350)
    assert page.locator('#hm-today [data-entry-row]').count() == 60
    assert page.locator('#hm-more').inner_text() == '已展示全部流水'

    seed(page, [*entries, {
        'id': 61, 'type': 'expense', 'amount': 200, 'occurredAt': dates['older'],
        'categoryId': 1, 'accountId': 1, 'note': '虚构更早流水',
    }])
    page.wait_for_function("document.querySelectorAll('#hm-today [data-entry-row]').length === 60")
    assert page.locator('#hm-more').inner_text() == '下拉加载更早的流水…'
    page.locator('#page-home').evaluate('element => { element.scrollTop = element.scrollHeight; }')
    page.wait_for_function("document.querySelectorAll('#hm-days [data-entry-row]').length === 61")
    assert page.locator('#hm-today [data-entry-row]').count() == 60
    assert page.locator('#hm-more').inner_text() == '已展示全部流水'


def home_dense_multi_page_day(page):
    dates = page.evaluate('''() => {
      const now = new Date();
      return [0, -1].map(offset => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12).getTime());
    }''')
    entries = [{
        'id': index + 1, 'type': 'expense', 'amount': 100,
        'occurredAt': dates[0], 'categoryId': 1, 'accountId': 1,
        'note': f'虚构密集流水{index + 1}',
    } for index in range(100)]
    seed(page, [*entries, {
        'id': 101, 'type': 'expense', 'amount': 200, 'occurredAt': dates[1],
        'categoryId': 1, 'accountId': 1, 'note': '虚构更早流水',
    }])
    page.wait_for_function("document.querySelectorAll('#hm-today [data-entry-row]').length === 100")
    assert page.locator('#hm-more').inner_text() == '下拉加载更早的流水…'
    page.locator('#page-home').evaluate('element => { element.scrollTop = element.scrollHeight; }')
    page.wait_for_function("document.querySelectorAll('#hm-days [data-entry-row]').length === 101")
    assert page.locator('#hm-today [data-entry-row]').count() == 100
    assert page.locator('#hm-more').inner_text() == '已展示全部流水'


if __name__ == '__main__':
    cases = [
        (offset_consistency, 390),
        (income_event_cross_month, 390),
        (budget_first_open_is_idempotent, 390),
        (calendar_refund_direction, 390),
        (calendar_picker_layered_back, 390),
        (home_dense_single_day_page, 390),
        *((home_dense_multi_page_day, width) for width in (360, 390, 430, 1024)),
        *((signed_refund_trend, width) for width in (360, 390, 430, 1024)),
    ]
    if os.environ.get('GLEAM_E2E_CASE'):
        cases = [case for case in cases if case[0].__name__ == os.environ['GLEAM_E2E_CASE']]
    failures = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for case, width in cases:
            context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block')
            page = context.new_page()
            page.set_default_timeout(7000)
            try:
                page.goto(URL)
                page.wait_for_load_state('networkidle')
                page.locator('#fab').wait_for()
                case(page)
                print('PASS', case.__name__, width, flush=True)
            except Exception:
                failures.append(f'{case.__name__}-{width}')
                print('FAIL', case.__name__, width, traceback.format_exc(), flush=True)
                print('HOME_METRICS', page.locator('#page-home').evaluate('''element => ({
                  active: element.classList.contains('is-active'), inert: element.inert,
                  top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight,
                  rows: element.querySelectorAll('[data-entry-row]').length,
                  todayRows: element.querySelectorAll('#hm-today [data-entry-row]').length,
                  more: element.querySelector('#hm-more')?.textContent,
                })'''), flush=True)
                page.screenshot(path=str(SHOTS / f'{case.__name__}-{width}-fail.png'))
            finally:
                context.close()
        browser.close()
    raise SystemExit(1 if failures else 0)
