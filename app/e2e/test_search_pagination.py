"""Search renders 20 rows per page; summaries and batch scope still cover all matches."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_search_summary_layout import URL, SEED

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/search-pagination'
EXTRA = '''async () => {
  const db = await new Promise(resolve => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result); });
  const tx = db.transaction('entries', 'readwrite'), entries = tx.objectStore('entries');
  entries.clear();
  for (let id = 1; id <= 45; id++) entries.put({id, type: id <= 40 ? 'expense' : 'income',
    amount: 100, accountId: 1, categoryId: id <= 40 ? 1 : 2, note: '虚构分页' + (id <= 3 ? '少量' : ''),
    occurredAt: Date.now() - id * 1000, deletedAt: 0, reimburseStatus: 'none', createdAt: 1, updatedAt: 1});
  await new Promise((resolve, reject) => {tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);}); db.close();
}'''


def run(browser, width, scale=1, theme="light"):
    context = browser.new_context(viewport={'width': width, 'height': 890}, service_workers='block', reduced_motion='reduce')
    context.route('**/*', lambda r: r.continue_() if r.request.url.startswith(URL) else r.abort())
    page = context.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(URL); page.locator('#fab').wait_for(); page.evaluate(SEED); page.evaluate(EXTRA)
        page.locator('#btn-search').click(); page.locator('#sr-input').fill('虚构分页')
        page.evaluate('([s,t]) => {document.documentElement.style.setProperty("--seed-type",s);document.documentElement.dataset.theme=t}', [str(scale), theme])
        rows = page.locator('#sr-results [data-eid]')
        more = page.locator('#sr-load-more')
        expect(rows).to_have_count(20)
        expect(page.locator('#sr-load-all')).to_be_visible()
        expect(more).to_have_text('加载更多（20/45笔）')
        expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text('40.00')
        expect(page.locator('[data-sf="income"] .sc-amount')).to_have_text('5.00')
        page.locator('#sr-batch').click()
        expect(page.locator('#sr-batch-count')).to_have_text('已选 45 / 45 笔')
        expect(rows).to_have_count(20)
        page.locator('#sr-batch').click()
        more.click(); expect(rows).to_have_count(40)
        rows.last.locator('.entry-swipe-content').click()
        page.locator('#sp-entry-view .sub-head [data-act="back"]').click()
        expect(rows).to_have_count(40)
        page.locator('#sr-load-all').click(); expect(rows).to_have_count(45)
        assert rows.evaluate_all('es => new Set(es.map(e => e.dataset.eid)).size') == 45
        expect(more).to_have_count(0)
        expect(page.locator('#sr-load-all')).to_have_count(0)
        expect(page.locator('.sr-list-end')).to_be_visible()
        page.locator('[data-sf="expense"]').click(); expect(rows).to_have_count(20)
        expect(more).to_have_text('加载更多（20/40笔）')
        page.locator('#sr-input').fill('虚构分页少量'); expect(rows).to_have_count(3)
        expect(more).to_have_count(0)
        expect(page.locator('#sr-load-all')).to_have_count(0)
        page.locator('#sr-input').fill('虚构分页'); expect(rows).to_have_count(20)
        expect(more).to_have_text('加载更多（20/40笔）')
        more.scroll_into_view_if_needed()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        assert page.locator('.sr-pagination button').evaluate_all('es => es.every(e => {const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44&&e.scrollWidth<=e.clientWidth+1})')
        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / f'pagination-{width}-{theme}-{scale}.png'), animations='disabled')
        page.locator('#sr-load-all').click(); expect(rows).to_have_count(40)
        assert rows.evaluate_all('es => es.every(e => Number(e.dataset.eid) <= 40)')
        expect(page.locator('#sr-load-all')).to_have_count(0)
        page.locator('[data-sf="all"]').click(); expect(rows).to_have_count(20)
        page.locator('#sr-load-all').focus(); page.locator('#sr-load-all').press('Enter')
        expect(rows).to_have_count(45)
        page.locator('#sr-input').fill('虚构分页少量'); expect(rows).to_have_count(3)
        page.locator('#sr-input').fill('虚构分页'); expect(rows).to_have_count(20)
        assert not errors, errors
        print('PASS search pagination, full totals, batch, return and filter reset', width, flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 400, 430, 1280): run(browser, width)
        run(browser, 400, 1.3, 'dark')
        browser.close()
