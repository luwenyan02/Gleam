"""退款构成口径及报表/日历易读性；所有账目均为虚构，不访问外部服务。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/report-composition'

SEED = '''async fixture => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('GleamDB');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const names = ['entries', 'accounts', 'categories', 'tags', 'entryTags', 'merchants', 'settings'];
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) tx.objectStore(name).clear();
  const now = Date.now();
  const date = day => new Date(new Date().getFullYear(), new Date().getMonth(), day, 12).getTime();
  for (let id = 1; id <= 3; id++) {
    tx.objectStore('accounts').put({id, name: `虚构账户${id}`, group: 'cash', balance: 100000,
      hidden: false, countInNetWorth: true, sortOrder: id, createdAt: now, updatedAt: now});
    tx.objectStore('categories').put({id, name: ['餐饮', '交通', '购物'][id - 1], kind: 'expense',
      icon: 'ic-tag', sortOrder: id, createdAt: now, updatedAt: now});
    tx.objectStore('tags').put({id, name: `虚构标签${id}`, createdAt: now, updatedAt: now});
    tx.objectStore('merchants').put({id, name: `虚构商家${id}`, createdAt: now, updatedAt: now});
  }
  tx.objectStore('categories').put({id: 4, name: '工资', kind: 'income', icon: 'ic-coin', sortOrder: 4, createdAt: now, updatedAt: now});
  let entries = [
    {id: 1, type: 'expense', amount: 6000, accountId: 1, categoryId: 1, merchantId: 1},
    {id: 2, type: 'expense', amount: 4000, accountId: 2, categoryId: 2, merchantId: 2},
    {id: 3, type: 'expense', amount: 2000, accountId: 3, categoryId: 3, merchantId: 3, refundFlag: true},
    {id: 4, type: 'income', amount: 50000, accountId: 1, categoryId: 4},
  ];
  if (fixture.mode === 'refund') entries = [entries[2]];
  if (fixture.mode === 'zero') entries[2].amount = 10000;
  if (fixture.mode === 'calendar') entries = [
    {...entries[0], amount: 12345678, occurredAt: date(2)},
    {...entries[2], amount: 999999999, occurredAt: date(3)},
    {...entries[3], occurredAt: date(2)},
  ];
  for (const entry of entries) tx.objectStore('entries').put({
    reimburseStatus: 'none', deletedAt: 0, occurredAt: date(1), createdAt: now, updatedAt: now, ...entry,
  });
  // 两笔支出同时打两个标签，明确重复计入的标签构成基数。
  for (const [id, entryId, tagId] of [[1,1,1],[2,1,2],[3,2,1],[4,2,2],[5,3,3]]) {
    tx.objectStore('entryTags').put({id, entryId, tagId});
  }
  for (const [key, value] of [['app.seeded', true], ['accounting.monthStartDay', 1], ['theme.mode', fixture.theme]]) {
    tx.objectStore('settings').put({key, value, updatedAt: now});
  }
  await new Promise((resolve, reject) => {tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);});
  db.close();
}'''


def seed(page, mode, theme):
    page.evaluate(SEED, {'mode': mode, 'theme': theme})
    page.reload()
    page.locator('#fab').wait_for()


def dimension(page, name):
    page.locator(f'#report-dim [data-dimension="{name}"]').click()
    page.locator('#report-rank-card:not([hidden])').wait_for()
    page.wait_for_function('(name) => document.querySelector("#rank [data-report-dim]")?.dataset.reportDim === name', arg=name)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        cases = [(width, 844, 1, 1) for width in (360, 390, 430, 1280)]
        cases += [(400, 890, 3, 1), (400, 810, 3, 1), (400, 810, 3, 1.3)]
        if os.environ.get('GLEAM_E2E_STRESS_ONLY'):
            cases = cases[-1:]
        for width, height, density, text_scale in cases:
            for theme in ('light', 'dark'):
                ctx = browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=density, service_workers='block', reduced_motion='reduce')
                label = f'{width}' if height == 844 else f'{width}x{height}-text{text_scale}'
                ctx.add_init_script(f"document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('--seed-type', '{text_scale}'));")
                page = ctx.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(URL) else route.abort())
                page.goto(URL)
                page.locator('#fab').wait_for()
                seed(page, 'mixed', theme)
                page.locator('.tab[data-page="page-report"]').click()
                dimension(page, 'category')
                page.wait_for_function("document.querySelector('#r-spend')?.textContent === '¥80.00'")
                assert [s.inner_text() for s in page.locator('#donut-legend b').all()] == ['60.0%', '40.0%']
                assert [s.inner_text() for s in page.locator('#rank .rank-pct').all()] == ['60.0%', '40.0%', '—']
                assert '正净支出 ¥100.00 − 退款净额 ¥20.00 = 净支出 ¥80.00' in page.locator('#donut-note').inner_text()
                assert page.locator('#rank .rank-section').inner_text() == '退款净额'
                assert page.locator('#rank .is-refund .rank-bar').count() == 0
                assert 'ic-food' in page.locator('#rank .rank-row').first.inner_html()
                assert page.locator('#rank .rank-pct').first.evaluate('e => parseFloat(getComputedStyle(e).fontSize) >= 13')
                page.screenshot(path=str(OUT / f'category-{label}-{theme}.png'), animations='disabled')
                page.locator('#report-rank-card').scroll_into_view_if_needed()
                page.screenshot(path=str(OUT / f'rank-{label}-{theme}.png'), animations='disabled')
                for name in ('account', 'merchant'):
                    dimension(page, name)
                    assert [s.inner_text() for s in page.locator('#rank .rank-pct').all()] == ['60.0%', '40.0%', '—']
                dimension(page, 'tag')
                assert [s.inner_text() for s in page.locator('#rank .rank-pct').all()] == ['50.0%', '50.0%', '—']
                assert '多标签账单重复计入' in page.locator('#rank-note').inner_text()
                dimension(page, 'income')
                assert page.locator('#rank .rank-pct').inner_text() == '100.0%'
                assert page.locator('#rank .rank-section').count() == 0
                page.locator('#r-seg [data-p="year"]').click()
                page.locator('#report-dim [data-dimension="trend"]').click()
                page.wait_for_function("document.querySelectorAll('#trend svg text').length === 12")
                assert page.locator('#trend svg text').first.get_attribute('font-size') == '13'
                assert page.locator('#trend').evaluate('e => e.scrollWidth <= e.clientWidth + 1')
                assert page.locator('#trend svg text').all_text_contents() == [str(month) for month in range(1, 13)]
                page.locator('#report-trend-card').scroll_into_view_if_needed()
                page.screenshot(path=str(OUT / f'year-{label}-{theme}.png'), animations='disabled')
                # 全年12个月同时可见，月份用数字简写而非缩小字号。
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                for mode, expected in [('zero', '¥0.00'), ('refund', '-¥20.00')]:
                    seed(page, mode, theme)
                    page.locator('.tab[data-page="page-report"]').click()
                    dimension(page, 'category')
                    page.wait_for_function('(expected) => document.querySelector("#r-spend")?.textContent === expected', arg=expected)
                    assert 'NaN' not in page.locator('#page-report').inner_text()
                    if mode == 'refund':
                        assert page.locator('#donut-svg .donut-hit').count() == 0
                        assert '暂无正净支出' in page.locator('#donut-svg').text_content()
                        assert page.locator('#rank .is-refund').count() == 1
                    else:
                        assert [s.inner_text() for s in page.locator('#donut-legend b').all()] == ['60.0%', '40.0%']
                seed(page, 'calendar', theme)
                page.locator('[data-qa="cal"]').click()
                page.locator('#sp-calendar .cal-grid').wait_for()
                day2 = page.locator('#sp-calendar [data-d="2"]')
                day3 = page.locator('#sp-calendar [data-d="3"]')
                assert day2.locator('.cd-amt').inner_text() == '-12.3万'
                assert day3.locator('.cd-amt').inner_text() == '+1000万'
                assert '¥123,456.78' in day2.get_attribute('aria-label')
                assert day2.locator('.cd-amt').evaluate('e => parseFloat(getComputedStyle(e).fontSize) >= 12')
                assert day3.locator('.cd-amt').evaluate('e => e.scrollWidth <= e.clientWidth + 1')
                if text_scale > 1:
                    amount = day3.locator('.cd-amt')
                    previous_font = amount.evaluate("e => e.style.fontFamily")
                    amount.evaluate("e => e.style.fontFamily = 'DejaVu Sans, sans-serif'")
                    try:
                        page.screenshot(path=str(OUT / f'calendar-wide-font-{label}-{theme}.png'), animations='disabled')
                        assert amount.evaluate('e => e.scrollWidth <= e.clientWidth + 1'), 'wide-font calendar amount overflows'
                        assert amount.evaluate('e => parseFloat(getComputedStyle(e).fontSize) >= 12')
                    finally:
                        amount.evaluate('(e, font) => e.style.fontFamily = font', previous_font)
                day2.click()
                page.wait_for_function("document.querySelector('#sp-calendar .cd-sum')?.textContent.includes('123,456.78')")
                assert '-¥123,456.78' in page.locator('#sp-calendar .cd-sum').inner_text()
                page.screenshot(path=str(OUT / f'calendar-{label}-{theme}.png'), animations='disabled')
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                assert not errors, errors
                print(f'PASS report composition, income, zero/refund, calendar {label} {theme}', flush=True)
                ctx.close()
        browser.close()


if __name__ == '__main__':
    main()
