"""Search clear control and horizontally scrollable summaries; fictional data only."""
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4602/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/search-summary-layout'
SEED = """async () => {
  const db = await new Promise(resolve => {
    const request = indexedDB.open('GleamDB');
    request.onsuccess = () => resolve(request.result);
  });
  const tx = db.transaction(['categories', 'accounts', 'entries'], 'readwrite');
  for (const name of ['categories', 'accounts', 'entries']) tx.objectStore(name).clear();
  const stamp = { createdAt: Date.now(), updatedAt: Date.now() };
  tx.objectStore('categories').put({ ...stamp, id: 1, name: '虚构支出', kind: 'expense', icon: 'ic-tag', sortOrder: 1 });
  tx.objectStore('categories').put({ ...stamp, id: 2, name: '虚构收入', kind: 'income', icon: 'ic-coin', sortOrder: 2 });
  tx.objectStore('accounts').put({ ...stamp, id: 1, name: '虚构账户', group: 'cash', balance: 0, hidden: false, countInNetWorth: true, sortOrder: 1 });
  const values = [
    ['expense', 24567890, '布局常规'], ['income', 1234567, '布局常规'],
    ['expense', 1234567890123, '布局长额'], ['income', 1234567890, '布局长额'],
    ['expense', 1234, '布局短额'], ['income', 500, '布局短额'],
  ];
  values.forEach(([type, amount, note], index) => tx.objectStore('entries').put({
    ...stamp, id: index + 1, type, amount, note, accountId: 1,
    categoryId: type === 'expense' ? 1 : 2, occurredAt: Date.now() - index * 1000,
    deletedAt: 0, reimburseStatus: 'none',
  }));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
}"""


def check_row(page):
    row = page.locator('.sr-summary-row')
    expect(row.locator('.sr-summary-card')).to_have_count(3)
    rects = row.locator('.sr-summary-card').evaluate_all('(els) => els.map(e => ({x:e.offsetLeft,y:e.offsetTop}))')
    assert max(r['y'] for r in rects) - min(r['y'] for r in rects) < 1, 'Summary cards must stay on one row'
    assert rects[0]['x'] < rects[1]['x'] < rects[2]['x']
    assert row.locator('.sc-amount').evaluate_all('(els) => els.every(e => e.scrollWidth <= e.clientWidth + 1)'), 'Amounts must remain complete'
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'Only the summary row may overflow'
    return row


def run(browser, width, scale, theme):
    context = browser.new_context(
        viewport={'width': width, 'height': 890 if width == 400 else 844},
        device_scale_factor=3 if width == 400 else 1,
        locale='zh-CN', timezone_id='Asia/Shanghai', service_workers='block', reduced_motion='reduce',
    )
    external, errors = [], []
    context.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(URL).netloc else (external.append(r.request.url), r.abort()))
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.locator('#fab').wait_for()
    page.evaluate(SEED)
    page.reload()
    page.locator('#btn-search').click()
    page.evaluate('([scale,theme]) => {document.documentElement.style.setProperty("--seed-type",scale);document.documentElement.dataset.theme=theme}', [str(scale), theme])
    search = page.locator('#sr-input')
    search.fill('布局常规')
    expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text('245,678.90')
    # Native search-cancel UI is at the right edge of the input. Clicking there
    # must not clear the term; only the separate app control should clear it.
    box = search.bounding_box()
    page.mouse.click(box['x'] + box['width'] - 8, box['y'] + box['height'] / 2)
    expect(search).to_have_value('布局常规')
    clear = page.get_by_role('button', name='清空搜索', exact=True)
    expect(clear).to_be_visible()
    row = check_row(page)
    page.screenshot(path=str(OUT / f'summary-{width}-text{scale}-{theme}.png'), animations='disabled')
    search.fill('布局短额')
    expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text('12.34')
    row = check_row(page)
    assert row.evaluate('e => e.scrollWidth <= e.clientWidth + 1'), 'Ordinary small amounts should fit'
    search.fill('布局长额')
    expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text('12,345,678,901.23')
    row = check_row(page)
    if width <= 430:
        assert row.evaluate('e => e.scrollWidth > e.clientWidth'), 'Long amounts should scroll locally'
        row.hover()
        page.mouse.wheel(1000, 0)
        page.wait_for_function('document.querySelector(".sr-summary-row").scrollLeft > 0')
    income = row.locator('[data-sf="income"]')
    income.scroll_into_view_if_needed()
    expect(income).to_be_in_viewport()
    income.click()
    expect(page.locator('#sr-results [data-eid]')).to_have_count(1)
    expect(page.locator('#sr-results [data-eid="4"]')).to_be_visible()
    row = check_row(page)
    row.locator('[data-sf="all"]').click()
    expect(page.locator('#sr-results [data-eid]')).to_have_count(2)
    page.screenshot(path=str(OUT / f'long-{width}-text{scale}-{theme}.png'), animations='disabled')
    search.fill('没有此虚构账单')
    expect(page.locator('#sr-results .sr-empty')).to_be_visible()
    check_row(page)
    clear.focus()
    clear.press('Enter')
    expect(search).to_have_value('')
    expect(search).to_be_focused()
    expect(clear).to_be_hidden()
    assert not errors, errors
    assert not external, external
    context.close()
    print('PASS search controls and summary layout', width, scale, theme, flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width, scale in [(360, 1), (390, 1), (400, 1), (400, 1.3), (430, 1), (1280, 1)]:
            for theme in ['light', 'dark']:
                run(browser, width, scale, theme)
        browser.close()
