"""Bounded entry-detail reads and responsive rendering with a large fictional ledger."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4602/')
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/entry-detail-performance'
AUDIT='''()=>{
 window.__reads={active:false,rows:{}};
 for(const [proto,indexed] of [[IDBObjectStore.prototype,false],[IDBIndex.prototype,true]]){
  for(const method of ['openCursor','getAll','get']){
   if(!proto[method])continue;const original=proto[method];
   proto[method]=function(...args){
    const request=original.apply(this,args),track=window.__reads.active;
    const name=(indexed?this.objectStore.name:this.name)+':'+(indexed?'index-':'store-')+method;
    if(track)request.addEventListener('success',()=>{
     const result=request.result,n=Array.isArray(result)?result.length:result?1:0;
     window.__reads.rows[name]=(window.__reads.rows[name]||0)+n;
    });return request;
   };
  }
 }
}'''

SEED='''async()=>{
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
 const names=['entries','categories','accounts','merchants','tags','entryTags'];const tx=db.transaction(names,'readwrite');
 for(const name of names)tx.objectStore(name).clear();const stamp={createdAt:1,updatedAt:1};
 for(let id=1;id<=40;id++)tx.objectStore('accounts').put({...stamp,id,name:'虚构账户'+id,group:'cash',balance:1000000,hidden:false,sortOrder:id});
 for(let id=1;id<=200;id++)tx.objectStore('categories').put({...stamp,id,name:'虚构分类'+id,kind:'expense',icon:'ic-bowl',sortOrder:id});
 for(let id=1;id<=2000;id++)tx.objectStore('merchants').put({...stamp,id,name:'虚构商家'+id,useCount:1});
 for(let id=1;id<=1000;id++)tx.objectStore('tags').put({...stamp,id,name:'虚构标签'+id});
 const now=Date.now();
 for(let id=1;id<=20000;id++)tx.objectStore('entries').put({...stamp,id,type:'expense',amount:10000,accountId:1,categoryId:1,merchantId:1,occurredAt:id<=20?now-id*1000:new Date(2020,0,1).getTime()+id*1000,note:'虚构性能账单'+id,deletedAt:0,reimburseStatus:'none'});
 tx.objectStore('entryTags').put({id:1,entryId:1,tagId:1});
 tx.objectStore('entryTags').put({id:2,entryId:1,tagId:1});
 tx.objectStore('entries').put({...stamp,id:20001,type:'expense',refundFlag:true,refundOfEntryId:1,amount:1500,accountId:1,categoryId:1,occurredAt:now+1000,deletedAt:0,reimburseStatus:'none'});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}'''

MEASURE='''selector=>new Promise((resolve,reject)=>{
 window.__reads.rows={};window.__reads.active=true;const start=performance.now();let readyAt=0,last=start,maxGap=0;
 const timer=setTimeout(()=>{observer.disconnect();reject(Error('Entry detail timed out'))},30000);
 const observer=new MutationObserver(()=>{if(!readyAt&&document.querySelector('#sp-entry-view .entry-view-hero')){readyAt=performance.now();observer.disconnect()}});
 observer.observe(document.querySelector('.app'),{childList:true,subtree:true});
 function frame(now){maxGap=Math.max(maxGap,now-last);last=now;if(readyAt&&now-readyAt>320){window.__reads.active=false;clearTimeout(timer);resolve({ready_ms:Math.round(readyAt-start),max_frame_gap_ms:Math.round(maxGap),rows:window.__reads.rows});return}requestAnimationFrame(frame)}
 requestAnimationFrame(frame);document.querySelector(selector).click();
})'''

def totals(page):
    return page.evaluate("""async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['entries','accounts']);
      const read=q=>new Promise(r=>q.onsuccess=()=>r(q.result));
      const result={entries:await read(tx.objectStore('entries').count()),accounts:await read(tx.objectStore('accounts').getAll())};
      db.close();return result;
    }""")


def run(browser,width,scale,theme):
    context=browser.new_context(viewport={'width':width,'height':890},device_scale_factor=3 if width==400 else 1,
                               locale='zh-CN',timezone_id='Asia/Shanghai',service_workers='block')
    external=[];errors=[]
    context.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc==urlsplit(URL).netloc else (external.append(r.request.url),r.abort()))
    page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED);page.reload();page.locator('#fab').wait_for()
    page.evaluate('([t,s])=>{document.documentElement.dataset.theme=t;document.documentElement.style.setProperty("--seed-type",String(s))}',[theme,scale])
    page.wait_for_timeout(700);before=totals(page);page.evaluate(AUDIT)
    session=context.new_cdp_session(page);session.send('Emulation.setCPUThrottlingRate',{'rate':4})
    results=[];label=f'{width}-{theme}-text{scale}'
    for route in ['home','account']:
        if route=='account':
            page.locator('[data-page="page-acct"]').click();page.locator('[data-acct="1"]').click()
            page.locator('.account-month-entries [data-eid="1"]').wait_for();page.wait_for_timeout(500)
            expect(page.locator('.account-month:not(.expanded) [data-eid]')).to_have_count(0)
            key=page.locator('.account-month.expanded').first.get_attribute('data-account-month')
            month=page.locator(f'.account-month[data-account-month="{key}"]')
            month.locator('.account-month-head').click();expect(month.locator('[data-eid]')).to_have_count(0)
            month.locator('.account-month-head').click();expect(month.locator('[data-eid]')).to_have_count(21)
        selector='#hm-days [data-entry="1"]' if route=='home' else '.account-month-entries [data-eid="1"]'
        for attempt in range(2):
            result=page.evaluate(MEASURE,selector);result.update(route=route,attempt=attempt+1);results.append(result)
            rows=result['rows']
            assert rows.get('entries:store-openCursor',0)==0,rows
            assert sum(n for key,n in rows.items() if key.startswith('entries:'))<=2,rows
            for key in ['merchants:store-getAll','tags:store-getAll','categories:index-getAll','accounts:index-getAll']:
                assert rows.get(key,0)==0,rows
            assert result['ready_ms']<800,result
            view=page.locator('#sp-entry-view')
            expect(view.locator('.entry-view-hero')).to_contain_text('虚构分类1')
            expect(view.locator('.entry-view-hero .out')).to_have_text('-100.00')
            expect(view.locator('[data-view-merchant="1"]')).to_contain_text('虚构商家1')
            expect(view.locator('[data-view-tag="1"]')).to_contain_text('虚构标签1')
            expect(view.locator('.refund-links')).to_contain_text('85.00')
            expect(view.locator('[data-view-action="refund"]')).to_have_attribute('aria-disabled','false')
            assert view.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
            if attempt==0:page.screenshot(path=str(OUT/f'{route}-{label}.png'),animations='disabled')
            view.locator('.sub-head [data-act="back"]').click();view.wait_for(state='detached');page.wait_for_timeout(200)
    assert totals(page)==before,'Read-only detail must not change ledger rows or balances'
    assert not errors,errors;assert not external,external
    (OUT/f'metrics-{label}.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
    context.close();print('PASS bounded entry detail, 20k ledger / 4x CPU slowdown',label,[r['ready_ms'] for r in results],flush=True)


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width,scale,theme in [(360,1,'light'),(390,1,'dark'),(400,1,'light'),(400,1.3,'dark'),(430,1,'light'),(1280,1,'dark')]:
            run(browser,width,scale,theme)
        browser.close()
