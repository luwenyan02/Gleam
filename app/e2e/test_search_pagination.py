"""Search renders 100 rows per page; summaries and batch scope still cover all matches."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_search_summary_layout import URL, SEED

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/search-pagination'
EXTRA = '''async () => {
  const db = await new Promise(resolve => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result); });
  const tx = db.transaction('entries', 'readwrite'), entries = tx.objectStore('entries');
  entries.clear();
  for (let id = 1; id <= 245; id++) entries.put({id, type: id <= 200 ? 'expense' : 'income',
    amount: 100, accountId: 1, categoryId: id <= 200 ? 1 : 2, note: '虚构分页' + (id <= 3 ? '少量' : ''),
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
        expect(rows).to_have_count(100)
        expect(page.locator('#sr-load-all')).to_be_visible()
        expect(more).to_have_text('加载更多（100/245笔）')
        expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text('200.00')
        expect(page.locator('[data-sf="income"] .sc-amount')).to_have_text('45.00')
        page.locator('#sr-batch').click()
        expect(page.locator('#sr-batch-count')).to_have_text('已选 245 / 245 笔')
        expect(rows).to_have_count(100)
        page.locator('#sr-batch').click()
        page.evaluate('''() => {window.__searchReads = 0;const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){window.__searchReads++;return original.apply(this,args)}}''')
        more.click(); expect(rows).to_have_count(200)
        assert page.evaluate('window.__searchReads') == 0, 'Pagination must reuse complete search results'
        page.locator('#sr-clear-input').click()
        expect(rows).to_have_count(0)
        page.locator('#sr-input').fill('虚构分页'); expect(rows).to_have_count(100)
        expect(more).to_have_text('加载更多（100/245笔）')
        page.evaluate('window.__searchReads = 0')
        more.click(); expect(rows).to_have_count(200)
        assert page.evaluate('window.__searchReads') == 0

        rows.last.locator('.entry-swipe-content').click()
        page.locator('#sp-entry-view .sub-head [data-act="back"]').click()
        expect(rows).to_have_count(200)
        page.evaluate('window.__searchReads = 0')
        page.locator('#sr-load-all').click(); expect(rows).to_have_count(245)
        assert page.evaluate('window.__searchReads') == 0
        assert rows.evaluate_all('es => new Set(es.map(e => e.dataset.eid)).size') == 245
        expect(more).to_have_count(0)
        expect(page.locator('#sr-load-all')).to_have_count(0)
        expect(page.locator('.sr-list-end')).to_be_visible()
        page.locator('[data-sf="expense"]').click(); expect(rows).to_have_count(100)
        expect(more).to_have_text('加载更多（100/200笔）')
        page.locator('#sr-input').fill('虚构分页少量'); expect(rows).to_have_count(3)
        expect(more).to_have_count(0)
        expect(page.locator('#sr-load-all')).to_have_count(0)
        page.locator('#sr-input').fill('虚构分页'); expect(rows).to_have_count(100)
        expect(more).to_have_text('加载更多（100/200笔）')
        more.scroll_into_view_if_needed()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        assert page.locator('.sr-pagination button').evaluate_all('es => es.every(e => {const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44&&e.scrollWidth<=e.clientWidth+1})')
        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / f'pagination-{width}-{theme}-{scale}.png'), animations='disabled')
        page.locator('#sr-load-all').click(); expect(rows).to_have_count(200)
        assert rows.evaluate_all('es => es.every(e => Number(e.dataset.eid) <= 200)')
        expect(page.locator('#sr-load-all')).to_have_count(0)
        page.locator('[data-sf="all"]').click(); expect(rows).to_have_count(100)
        page.locator('#sr-load-all').focus(); page.locator('#sr-load-all').press('Enter')
        expect(rows).to_have_count(245)
        page.locator('#sr-input').fill('虚构分页少量'); expect(rows).to_have_count(3)
        page.locator('#sr-input').fill('虚构分页'); expect(rows).to_have_count(100)
        # Clearing and immediately retyping must reset even before the debounce fires.
        more.click(); expect(rows).to_have_count(200)
        page.locator('#sr-input').fill(''); page.locator('#sr-input').fill('虚构分页')
        expect(rows).to_have_count(100)
        # The final partial page removes its button; keyboard focus continues at the first added row.
        more.click(); expect(rows).to_have_count(200)
        more.focus(); more.press('Enter'); expect(rows).to_have_count(245)
        expect(page.locator('#sr-results [data-eid="201"] .entry-swipe-content')).to_be_focused()
        page.locator('#sr-input').fill(''); page.locator('#sr-input').fill('虚构分页')
        expect(rows).to_have_count(100)
        # A real repository write from details must invalidate cached matches/totals.
        rows.first.locator('.entry-swipe-content').click()
        page.locator('#sp-entry-view [data-view-action="delete"]').click()
        page.locator('#dialog-scrim [data-act="ok"]').click()
        expect(page.locator('#sp-entry-view')).to_have_count(0)
        expect(more).to_have_text('加载更多（100/244笔）')
        expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text('199.00')
        page.locator('#sr-batch').click()
        expect(page.locator('#sr-batch-count')).to_have_text('已选 244 / 244 笔')
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
