"""Large search results stay reachable without mounting every row (fictional data)."""
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright
from test_page_open_performance import AUDIT
from test_search_summary_layout import SEED as BASE_SEED

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/search-windowing'
SEED = r'''async ({count, singleDay}) => {
  const db = await new Promise(resolve => {const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
  const tx=db.transaction(['entries','lifeNotes','categories'], 'readwrite'), entries=tx.objectStore('entries');entries.clear();
  tx.objectStore('categories').put({id:3,name:'虚构改分类',kind:'expense',icon:'ic-tag',sortOrder:3,createdAt:1,updatedAt:1});
  const now=new Date(2026,9,28,12).getTime();
  for(let id=1;id<=count+3;id++) entries.put({id,type:'expense',amount:100,accountId:1,categoryId:1,
    note:(id<=count?'虚构窗口':'不匹配')+id, occurredAt:now-(singleDay?id*1000:Math.floor((id-1)/80)*86400000+id*1000),
    deletedAt:0,reimburseStatus:id%9===0?'done':'none',reimbursedAmount:id%9===0?25:undefined,createdAt:1,updatedAt:1});
  tx.objectStore('lifeNotes').clear();
  tx.objectStore('lifeNotes').put({id:1,kind:'diary',title:'虚构窗口生活',body:'保持生活搜索结果',occurredAt:now,deletedAt:0,createdAt:1,updatedAt:1});
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}'''


def settle(page):
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')


def bound(page):
    counts = page.evaluate('''() => ({rows:document.querySelectorAll('#sr-results [data-eid]').length,
      nodes:document.querySelectorAll('#sr-results *').length})''')
    assert counts['rows'] <= 300 and counts['nodes'] < 7000, counts
    return counts


def run(browser, width=400, count=21422, single_day=True, scale=1, theme='light'):
    context = browser.new_context(viewport={'width': width, 'height': 890}, device_scale_factor=3 if width == 400 else 1,
        service_workers='block', reduced_motion='reduce', timezone_id='Asia/Shanghai', locale='zh-CN')
    context.add_init_script(AUDIT)
    errors, external = [], []
    context.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(URL).netloc
        else (external.append(r.request.url), r.abort()))
    page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        page.goto(URL); page.locator('#fab').wait_for(); page.evaluate(BASE_SEED)
        page.evaluate(SEED, {'count': count, 'singleDay': single_day})
        page.locator('#btn-search').click(); page.locator('#sr-input').fill('虚构窗口')
        page.evaluate('([s,t])=>{document.documentElement.style.setProperty("--seed-type",s);document.documentElement.dataset.theme=t}', [str(scale), theme])
        rows = page.locator('#sr-results [data-eid]')
        expect(rows).to_have_count(100)
        expect(page.locator('#sr-load-more')).to_have_text(f'加载更多（100/{count}笔）')
        expect(page.locator('#sr-results [data-nid="1"]')).to_have_count(1)
        expense = (count * 100 - (count // 9) * 25) / 100
        expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text(f'{expense:,.2f}')
        if single_day:
            expect(page.locator('.sr-day-head').first).to_contain_text(f'支出 {expense:,.2f}')
        page.evaluate('window.__nav={rows:{},requests:{},active:true,start:performance.now()}')
        page.locator('#sr-load-more').click(); expect(rows).to_have_count(200)
        performance = page.evaluate('''async () => {const start=performance.now();document.querySelector('#sr-load-all').click();
          const sync=performance.now()-start;await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));
          return {sync_ms:Math.round(sync),through_next_frame_ms:Math.round(performance.now()-start)}}''')
        settle(page)
        performance.update(bound(page))
        assert page.evaluate('Object.keys(window.__nav.requests).length') == 0, 'Paging must not read the database'
        expect(page.locator('#sr-load-more')).to_have_count(0)
        expect(page.locator('#sr-results [data-nid="1"]')).to_have_count(1)
        page.locator('#sp-search .sub-body').evaluate('e=>e.scrollTop=0'); settle(page)
        page.screenshot(path=str(OUT / f'window-{width}-{theme}-{scale}-top.png'), animations='disabled')
        # A scrollbar jump must immediately materialize the final record, without walking intermediate windows.
        page.locator('#sp-search .sub-body').evaluate('e=>e.scrollTop=e.scrollHeight'); settle(page)
        expect(page.locator(f'#sr-results [data-eid="{count}"]')).to_be_visible()
        bound(page)
        page.screenshot(path=str(OUT / f'window-{width}-{theme}-{scale}-end.png'), animations='disabled')
        page.evaluate('''async () => {const body=document.querySelector('#sp-search .sub-body');
          for(let i=0;i<4;i++){body.scrollTop=0;await new Promise(requestAnimationFrame);body.scrollTop=body.scrollHeight;await new Promise(requestAnimationFrame)}
          body.scrollTop=0;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}''')
        expect(page.locator('#sr-results [data-eid="1"]')).to_be_in_viewport()
        # Visiting overlapping windows must discover every ID exactly once, including a giant single day.
        reached = page.evaluate('''async count => {
          const body=document.querySelector('#sp-search .sub-body'),seen=new Set();let loops=0,maxRows=0,maxNodes=0,stalled=0;
          body.scrollTop=0;
          for(;loops<count;loops++) {
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            const before=seen.size,rows=[...document.querySelectorAll('#sr-results [data-eid]')];rows.forEach(e=>seen.add(Number(e.dataset.eid)));
            stalled=seen.size===before?stalled+1:0;
            if(stalled>8)throw Error('Scrolling stopped exposing results '+JSON.stringify({seen:seen.size,top:body.scrollTop,first:rows[0]?.dataset.eid,last:rows.at(-1)?.dataset.eid}));
            maxRows=Math.max(maxRows,rows.length);maxNodes=Math.max(maxNodes,document.querySelectorAll('#sr-results *').length);
            if(seen.size===count)break;
            // A focused block may remain mounted beyond the visible window. Walk only
            // the contiguous run containing a visible row, so that retained focus cannot skip IDs.
            const top=body.getBoundingClientRect().top;
            const first=rows.findIndex(e=>{const r=e.getBoundingClientRect();return r.bottom>top&&r.top<top+body.clientHeight});
            let last=rows[first];if(!last)throw Error('No visible rows while traversing');
            for(let i=first+1;i<rows.length&&Number(rows[i].dataset.eid)===Number(last.dataset.eid)+1;i++)last=rows[i];
            body.scrollTop+=last.getBoundingClientRect().top-body.getBoundingClientRect().top;
          }
          return {count:seen.size,min:Math.min(...seen),max:Math.max(...seen),maxRows,maxNodes,loops};
        }''', count)
        assert reached['count'] == count and reached['min'] == 1 and reached['max'] == count, reached
        assert reached['maxRows'] <= 300 and reached['maxNodes'] < 7000, reached
        assert page.evaluate('Object.keys(window.__nav.requests).length') == 0
        page.locator('.sr-list-end').scroll_into_view_if_needed(); settle(page)
        expect(page.locator('#sr-results [data-eid]').last).to_have_attribute('data-eid', str(count))
        expect(page.locator('#sr-results [data-nid="1"]')).to_be_visible()
        # A focused, visible row survives scroll updates and a detail round trip.
        last = page.locator(f'#sr-results [data-eid="{count}"] .entry-swipe-content')
        last.scroll_into_view_if_needed(); last.focus(); settle(page)
        before = page.locator('#sp-search .sub-body').evaluate('e=>e.scrollTop')
        last.press('Enter'); page.locator('#sp-entry-view .sub-head [data-act="back"]').click()
        expect(last).to_be_focused(); settle(page)
        assert abs(page.locator('#sp-search .sub-body').evaluate('e=>e.scrollTop') - before) < 3
        bound(page)
        # Keyboard navigation crosses a window boundary without skipping unmounted results.
        page.locator('#sp-search .sub-body').evaluate('e=>e.scrollTop=0'); settle(page)
        first = page.locator('#sr-results [data-eid="1"] .entry-swipe-content'); first.focus()
        for _ in range(150): page.keyboard.press('Tab')
        focused = page.evaluate('document.activeElement.closest("[data-eid]")?.dataset.eid')
        assert focused == '31', focused  # Four native quick actions + the row button per entry.
        for _ in range(50): page.keyboard.press('Shift+Tab')
        assert page.evaluate('document.activeElement.closest("[data-eid]")?.dataset.eid') == '21'
        for _ in range(50): page.keyboard.press('Tab')
        bound(page)
        # Width/font changes remeasure visible blocks, retaining the reading position.
        page.set_viewport_size({'width': 390 if width != 390 else 430, 'height': 890})
        page.evaluate('document.documentElement.style.setProperty("--seed-type","1.3")'); settle(page)
        expect(page.locator('#sr-results [data-eid="31"] .entry-swipe-content')).to_be_focused()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        # Consecutive mounted chunks touch: variable-height rows cannot overlap or leave an estimate-sized gap.
        assert page.locator('.sr-window-block').evaluate_all('''nodes => nodes.every((node,i) => !i ||
          Number(node.dataset.block)!==Number(nodes[i-1].dataset.block)+1 ||
          Math.abs(node.getBoundingClientRect().top-nodes[i-1].getBoundingClientRect().bottom)<1)''')
        bound(page)
        page.screenshot(path=str(OUT / f'window-{width}-{theme}-{scale}-resized.png'), animations='disabled')
        # Swipe listeners are delegated, so a freshly mounted row keeps its normal actions.
        swiped = page.locator('#sr-results [data-eid="31"]')
        swiped.scroll_into_view_if_needed(); settle(page)
        middle = swiped.locator('.entry-swipe-content'); middle.focus()
        middle_top = page.locator('#sp-search .sub-body').evaluate('e=>e.scrollTop')
        middle.press('Enter')
        expect(page.locator('#sp-search')).to_have_attribute('inert', '')
        page.locator('#sp-entry-view .sub-head [data-act="back"]').click()
        expect(middle).to_be_focused(); settle(page)
        assert abs(page.locator('#sp-search .sub-body').evaluate('e=>e.scrollTop') - middle_top) < 3
        box = swiped.bounding_box(); y = box['y'] + box['height'] / 2
        page.mouse.move(box['x'] + box['width'] - 20, y); page.mouse.down()
        page.mouse.move(box['x'] + 20, y, steps=8); page.mouse.up()
        expect(swiped).to_have_class(re.compile(r'\bswipe-open\b'))
        page.keyboard.press('Escape'); expect(swiped).not_to_have_class(re.compile(r'\bswipe-open\b'))
        # Crossing from the full 300-row page into windows preserves the first visible row and its offset.
        page.locator('#sr-input').fill('不匹配'); expect(rows).to_have_count(3)
        page.locator('#sr-input').fill('虚构窗口'); expect(rows).to_have_count(100)
        page.locator('#sr-load-more').click(); expect(rows).to_have_count(200)
        page.locator('#sr-load-more').click(); expect(rows).to_have_count(300)
        page.locator('#sr-load-more').scroll_into_view_if_needed()
        transition = page.evaluate('''() => {const body=document.querySelector('#sp-search .sub-body'),top=body.getBoundingClientRect().top;
          const row=[...document.querySelectorAll('#sr-results [data-eid]')].find(e=>e.getBoundingClientRect().bottom>top);
          return {id:row.dataset.eid,top:row.getBoundingClientRect().top-top}}''')
        page.locator('#sr-load-more').click(); settle(page); bound(page)
        expect(page.locator('#sr-load-more')).to_have_text(f'加载更多（400/{count}笔）')
        actual_top = page.locator(f'#sr-results [data-eid="{transition["id"]}"]').evaluate('e=>e.getBoundingClientRect().top-e.closest(".sub-body").getBoundingClientRect().top')
        assert abs(actual_top - transition['top']) < 3, (transition, actual_top)
        # Full-result selection includes rows outside the DOM; an actual batch write must touch exactly those IDs.
        page.locator('#sr-batch').click()
        expect(page.locator('#sr-batch-count')).to_have_text(f'已选 {count} / {count} 笔')
        page.locator('#sr-batch-all').click(); expect(page.locator('#sr-batch-count')).to_have_text(f'已选 0 / {count} 笔')
        page.locator('#sr-batch-all').click(); expect(page.locator('#sr-batch-count')).to_have_text(f'已选 {count} / {count} 笔')
        page.locator('#sp-search [data-batch-act="category"]').click()
        page.locator('#sheet [data-pick="3"]').click()
        expect(page.locator('#dialog-scrim')).to_contain_text(f'可处理 {count} 笔')
        page.locator('#dialog-scrim [data-act="ok"]').click()
        # This checks exact batch scope, not IndexedDB's large write throughput.
        expect(page.locator('#toast')).to_contain_text(f'已改分类 {count} 笔', timeout=90000)
        expect(page.locator('#sr-batch-bar')).to_be_hidden()
        actual = page.evaluate('''async () => {const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
          const entries=await new Promise(r=>{const q=db.transaction('entries').objectStore('entries').getAll();q.onsuccess=()=>r(q.result)});db.close();
          return {changed:entries.filter(e=>e.categoryId===3).map(e=>e.id).sort((a,b)=>a-b),unchanged:entries.filter(e=>e.categoryId!==3).map(e=>e.id).sort((a,b)=>a-b)}}''')
        assert actual['changed'] == list(range(1, count+1)) and actual['unchanged'] == list(range(count+1, count+4)), actual
        expect(page.locator('#sr-results [data-nid="1"]')).to_have_count(1)
        assert not errors and not external, (errors, external)
        (OUT / f'window-{width}-{count}.json').write_text(json.dumps({'performance': performance, 'reachability': reached}, indent=2))
        print('PASS search windowing', width, count, performance, reached, flush=True)
    except Exception:
        print('SEARCH_WINDOW_FAILURE', page.evaluate('''() => ({toast:document.querySelector('#toast')?.textContent,
          batch:document.querySelector('#sr-batch-count')?.textContent,busy:document.querySelector('#sr-batch-bar')?.getAttribute('aria-busy'),
          dialogs:document.querySelector('#dialog-scrim')?.textContent,pending:window.__navPending(),reads:window.__nav.requests})'''), errors, flush=True)
        page.screenshot(path=str(OUT / f'failure-{width}-{count}.png'), animations='disabled')
        raise
    finally:
        context.close()


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch()
        run(browser)
        for width in (360, 390, 430, 1280): run(browser, width, count=1200, single_day=False)
        run(browser, 400, count=1200, single_day=False, scale=1.3, theme='dark')
        browser.close()
