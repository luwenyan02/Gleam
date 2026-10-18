"""Account detail uses indexed reads and bounded DOM with fictional large ledgers."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect
from test_entry_detail_performance import AUDIT, totals

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4602/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/account-detail-performance'

SEED = '''async dense => {
 const db = await new Promise(resolve => {
   const q = indexedDB.open('GleamDB'); q.onsuccess = () => resolve(q.result);
 });
 const tx = db.transaction(['entries','accounts','categories'], 'readwrite');
 for (const name of ['entries','accounts','categories']) tx.objectStore(name).clear();
 const stamp = {createdAt:1, updatedAt:1};
 for (let id=1; id<=40; id++) tx.objectStore('accounts').put({...stamp,id,
   name:'虚构性能账户'+id,group:'cash',balance:1000000,hidden:false,sortOrder:id});
 for (let id=1; id<=600; id++) tx.objectStore('categories').put({...stamp,id,
   name:'虚构分类'+id,kind:'expense',icon:'ic-bowl',sortOrder:id});
 const now = Date.now();
 for (let id=1; id<=20000; id++) tx.objectStore('entries').put({...stamp,id,
   type:'expense', amount:100, accountId:dense||id<=30?1:2, categoryId:1,
   occurredAt:id<=(dense?2000:20)?now-id*1000:new Date(2020,0,1).getTime()+id*1000,
   note:'虚构性能流水'+id,deletedAt:0,reimburseStatus:'none'});
 await new Promise((resolve,reject) => {tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
 db.close();
}'''

MEASURE = '''selector => new Promise((resolve,reject) => {
 window.__reads.rows={};window.__reads.active=true;
 const start=performance.now();let readyAt=0,last=start,maxGap=0;
 const timer=setTimeout(()=>{observer.disconnect();reject(Error('account detail timed out'))},30000);
 const observer=new MutationObserver(()=>{
   if(!readyAt&&document.querySelector('#sp-account-detail .account-detail-hero')){
     readyAt=performance.now();observer.disconnect();
   }
 });
 observer.observe(document.querySelector('.app'),{childList:true,subtree:true});
 function frame(now){
   maxGap=Math.max(maxGap,now-last);last=now;
   if(readyAt&&now-readyAt>320){window.__reads.active=false;clearTimeout(timer);
     resolve({ready_ms:Math.round(readyAt-start),max_frame_gap_ms:Math.round(maxGap),rows:window.__reads.rows});return;}
   requestAnimationFrame(frame);
 }
 requestAnimationFrame(frame);document.querySelector(selector).click();
})'''


def run(browser, width, scale, theme, dense):
    label = f'{width}-{theme}-text{scale}-{"dense" if dense else "sparse"}'
    context = browser.new_context(viewport={'width': width, 'height': 890},
        device_scale_factor=3 if width == 400 else 1, timezone_id='Asia/Shanghai',
        color_scheme=theme,
        service_workers='block')
    errors = []
    external = []
    context.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(URL).netloc
        else (external.append(r.request.url), r.abort()))
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.locator('#fab').wait_for()
    page.evaluate(SEED, dense)
    page.reload()
    page.locator('#fab').wait_for()
    page.evaluate('([t,s])=>{document.documentElement.dataset.theme=t;document.documentElement.style.setProperty("--seed-type",String(s))}', [theme, scale])
    page.locator('[data-page="page-acct"]').click()
    page.locator('[data-acct="1"]').wait_for()
    page.wait_for_timeout(500)
    before = totals(page)
    page.evaluate(AUDIT)
    session = context.new_cdp_session(page)
    session.send('Emulation.setCPUThrottlingRate', {'rate': 4})
    results = []
    for attempt in range(2):
        result = page.evaluate(MEASURE, '[data-acct="1"]')
        results.append(result)
        (OUT / f'metrics-{label}.json').write_text(json.dumps(results, indent=2)+'\n')
        rows = result['rows']
        assert rows.get('entries:store-openCursor', 0) == 0, result
        assert sum(n for key,n in rows.items() if key.startswith('entries:')) <= (20000 if dense else 30), result
        for table in ('accounts','categories'):
            assert rows.get(table+':store-getAll',0) == 0 and rows.get(table+':index-getAll',0) == 0, result
        # Shared-runner wall time needs headroom for reading 20k relevant records;
        # indexed-read counts, DOM limits and long-frame bounds remain strict.
        assert result['ready_ms'] < (1500 if dense else 500), result
        assert result['max_frame_gap_ms'] < 600, result
        detail = page.locator('#sp-account-detail')
        assert page.evaluate('document.documentElement.dataset.theme === "dark"') == (theme == 'dark')
        assert page.evaluate('parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--seed-type"))') == scale
        expect(detail.locator('.account-current-balance')).to_contain_text('10,000.00')
        expect(detail.locator('.account-flow-total')).to_contain_text('30.00' if not dense else '20,000.00')
        expect(detail.locator('.account-month:not(.expanded) [data-eid]')).to_have_count(0)
        newest = detail.locator('.account-month.expanded')
        expect(newest.locator('[data-eid]')).to_have_count(80 if dense else 20)
        expect(newest.locator('[data-eid="1"] .account-entry-balance')).to_contain_text('10,000.00')
        assert detail.evaluate('el=>el.scrollWidth<=el.clientWidth+1')
        if attempt == 0:
            page.screenshot(path=str(OUT / f'{label}.png'), animations='disabled')
        # Loading months / trend navigation must reuse the current read-only snapshot.
        page.evaluate('window.__reads.rows={};window.__reads.active=true')
        if dense:
            more = newest.locator('[data-account-more-entries]')
            expect(more).to_contain_text('80 / 2000')
            more.click()
            expect(newest.locator('[data-eid]')).to_have_count(160)
            expect(newest.locator('[data-eid="160"] .account-entry-balance')).to_contain_text('10,159.00')
            newest.locator('.account-month-head').click()
            expect(newest.locator('[data-eid]')).to_have_count(0)
            detail.locator('.account-month').first.locator('.account-month-head').click()
            expect(detail.locator('.account-month.expanded [data-eid]')).to_have_count(160)
        if detail.locator('.balance-trend').get_attribute('open') is None:
            detail.locator('.balance-trend-heading').click()
        detail.locator('[data-trend-shift="-6"]').click()
        page.wait_for_timeout(150)
        assert sum(page.evaluate('window.__reads.rows').values()) == 0
        page.evaluate('window.__reads.active=false')
        detail.locator('.sub-head [data-act="back"]').click()
        detail.wait_for(state='detached')
        page.wait_for_timeout(200)
    assert totals(page) == before
    assert not errors, errors
    assert not external, external
    context.close()
    print('PASS account detail / 20k ledger / 4x CPU', label, [r['ready_ms'] for r in results], flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width, scale, theme in [(360,1,'light'), (390,1,'dark'), (400,1.3,'light'),
                (400,1.3,'dark'), (430,1,'light'), (1280,1,'light')]:
            for dense in (False, True):
                run(browser, width, scale, theme, dense)
        browser.close()
