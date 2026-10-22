"""Page opening stays bounded with a fictional 20k ledger, 80 tags and 4x CPU.

Measures real UI actions and IDB reads; uses no native signing or remote service.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/page-open-performance'

AUDIT=r'''(()=>{
 let pending=0,last=performance.now();window.__nav={rows:{},requests:{},active:true,start:0};
 window.__navPending=()=>pending;window.__navLast=()=>last;
 for(const proto of [IDBObjectStore.prototype,IDBIndex.prototype])for(const method of ['get','getAll','getAllKeys','count','openCursor','openKeyCursor']){
  const original=proto[method];if(!original)continue;
  proto[method]=function(...args){const req=original.apply(this,args),n=this.objectStore?.name??this.name,index=this.objectStore?this.name:'store';
   const scope=window.__nav,tracked=scope.active;let first=true;pending++;last=performance.now();
   if(tracked){const k=n+':'+index+':'+method;scope.requests[k]=(scope.requests[k]??0)+1;}
   const done=()=>{if(first){pending--;first=false;}last=performance.now();};
   req.addEventListener('error',done);req.addEventListener('success',()=>{done();if(!tracked)return;
    const k=n+':'+index+':'+method,res=req.result,qty=Array.isArray(res)?res.length:res?1:0;scope.rows[k]=(scope.rows[k]??0)+qty;
   });return req;
  }
 }
})();'''

SEED=r'''async count=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
 const names=['entries','accounts','categories','entryTags','tags','merchants','lifeNotes','habits','habitChecks','budgets','categoryBudgets'];
 const tx=db.transaction(names,'readwrite'),stamp={createdAt:1,updatedAt:1};
 const cats=await new Promise(resolve=>{const r=tx.objectStore('categories').getAll();r.onsuccess=()=>resolve(r.result)});
 const expense=cats.find(c=>c.kind==='expense'&&c.parentId!=null).id,income=cats.find(c=>c.kind==='income').id;
 for(const name of ['entries','entryTags','tags','merchants','lifeNotes','habits','habitChecks','budgets','categoryBudgets'])tx.objectStore(name).clear();
 for(let i=0;i<40;i++)tx.objectStore('accounts').put({...stamp,id:200+i,group:'cash',name:'虚构巡检账户'+i,balance:1000000,hidden:false,countInNetWorth:true,sortOrder:200+i});
 for(let i=0;i<80;i++){tx.objectStore('tags').put({...stamp,id:1000+i,name:'虚构标签'+i});tx.objectStore('merchants').put({...stamp,id:1000+i,name:'虚构商家'+i,useCount:i});}
 const now=new Date();let link=1;
 for(let id=1;id<=count;id++){
  const occurredAt=id<=20?Date.now()-id*1000:new Date(now.getFullYear(),now.getMonth()-(id%24),1+id%18,9,17).getTime();
  tx.objectStore('entries').put({...stamp,id,type:id%7?'expense':'income',amount:(id%40+1)*100,accountId:200+id%40,categoryId:id%7?expense:income,
   occurredAt,note:'虚构巡检流水'+id+'记录'.repeat(50),deletedAt:0,reimburseStatus:id%500?'none':'pending',merchantId:1000+id%80});
  if(id%3===0)tx.objectStore('entryTags').put({id:link++,entryId:id,tagId:1000+id%80});
 }
 for(let id=1;id<=Math.min(2400,count);id++)tx.objectStore('lifeNotes').put({...stamp,id,kind:'diary',title:'虚构生活记录'+id,body:'虚构正文'.repeat(40),occurredAt:new Date(now.getFullYear(),now.getMonth()-id%24,1+id%18,12).getTime(),deletedAt:0});
 const month=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');tx.objectStore('budgets').put({...stamp,id:1,month,totalLimit:10000000,autoCarry:false});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}'''

MEASURE=r'''async({selector,target,reset=true})=>{
 if(reset)window.__nav={rows:{},requests:{},active:true,start:performance.now()};
 const audit=window.__nav,start=audit.start;let changed=performance.now(),shell=0,maxGap=0,frameLast=performance.now(),running=true;
 const root=document.querySelector('.app'),obs=new MutationObserver(()=>{changed=performance.now();if(!shell&&document.querySelector(target)?.textContent.trim())shell=performance.now()-start;});
 obs.observe(root,{childList:true,subtree:true,characterData:true});
 function frame(t){if(!running)return;maxGap=Math.max(maxGap,t-frameLast);frameLast=t;requestAnimationFrame(frame)}requestAnimationFrame(frame);
 if(selector){const b=document.querySelector(selector);if(!b)throw Error('Missing action '+selector);b.click();}
 const deadline=performance.now()+60000;
 try{
  while(performance.now()<deadline){
   const last=Math.max(changed,window.__navLast());
   if(document.querySelector(target)?.textContent.trim()&&window.__navPending()===0&&performance.now()-last>=220){
    audit.active=false;return {shell_ms:Math.round(shell),ready_ms:Math.round(last-start),max_frame_gap_ms:Math.round(maxGap),rows:audit.rows,requests:audit.requests,dom:document.querySelector(target).querySelectorAll('*').length};
   }
   await new Promise(r=>setTimeout(r,25));
  }
  throw Error('Navigation timed out '+selector+' '+target+' pending='+window.__navPending());
 }finally{running=false;obs.disconnect();audit.active=false;}
}'''

def run(browser, width, theme):
    context = browser.new_context(viewport={'width': width, 'height': 890}, timezone_id='Asia/Shanghai',
        service_workers='block', reduced_motion='reduce')
    context.add_init_script(AUDIT)
    external = []
    context.route('**/*', lambda route: route.continue_() if urlsplit(route.request.url).netloc == urlsplit(URL).netloc
        else (external.append(route.request.url), route.abort()))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL)
    page.locator('#fab').wait_for()
    page.evaluate(SEED, 20000)
    session = context.new_cdp_session(page)
    session.send('Emulation.setCPUThrottlingRate', {'rate': 4})
    page.reload()
    page.locator('#hm-days').wait_for()
    page.evaluate('(theme)=>document.documentElement.dataset.theme=theme', theme)
    page.evaluate(MEASURE, {'selector': None, 'target': '#hm-days', 'reset': False})
    results = {}

    def measure(name, selector, target):
        result = page.evaluate(MEASURE, {'selector': selector, 'target': target})
        results[name] = result
        assert result['ready_ms'] < 5000, (name, result)
        return result

    def settle(target):
        page.evaluate(MEASURE, {'selector': None, 'target': target})

    def close(target):
        page.locator('.subpage.open').last.locator('.sub-head [data-act="back"]').click()
        page.locator('.subpage').wait_for(state='detached')
        settle(target)

    def entry_reads(result):
        return sum(value for key, value in result['rows'].items() if key.startswith('entries:'))

    for attempt in range(2):
        if attempt == 0:
            # Open the loading trend immediately; its eventual chart must retain that choice.
            page.evaluate('''()=>{
              const observer=new MutationObserver(()=>{
                const summary=document.querySelector('#page-acct [data-net-trend] summary');
                if(summary){observer.disconnect();summary.click();}
              });
              observer.observe(document.querySelector('#page-acct'),{childList:true,subtree:true});
            }''')
        account = measure('account-' + str(attempt), '[data-page="page-acct"]', '#page-acct')
        assert account['shell_ms'] < 1000 and account['max_frame_gap_ms'] < 1400, account
        expect(page.locator('#page-acct [data-acct="200"]')).to_be_visible()
        assert page.locator('#page-acct [data-net-trend] .balance-trend').count() == 1
        expect(page.locator('#page-acct [data-net-trend] .balance-trend-chart')).to_be_visible()
        report = measure('report-' + str(attempt), '[data-page="page-report"]', '#page-report')
        assert entry_reads(report) < 1700, report  # One current-month snapshot, not one read per card.
        expect(page.locator('#r-spend')).not_to_have_text('¥0.00')
        measure('mine-' + str(attempt), '[data-page="page-mine"]', '#page-mine')
        reimburse = measure('reimburse-' + str(attempt), '#page-mine [data-sub="sp-reimburse"]', '#sp-reimburse .sub-body')
        assert entry_reads(reimburse) <= 40, reimburse
        close('#page-mine')
        measure('home-' + str(attempt), '[data-page="page-home"]', '#page-home')
        calendar = measure('calendar-' + str(attempt), '[data-qa="cal"]', '#sp-calendar .sub-body')
        assert entry_reads(calendar) < 1700, calendar
        assert not any(key.startswith('entryTags:') for key in calendar['requests']), calendar
        close('#page-home')
        search = measure('search-' + str(attempt), '#btn-search', '#sp-search .sub-body')
        assert entry_reads(search) <= 1, search
        close('#page-home')
        if attempt == 0:
            page.screenshot(path=str(OUT / f'home-{width}-{theme}.png'), animations='disabled')
    # A real continued scroll must load older records even while offscreen row heights settle.
    previous_count = page.locator('#hm-days [data-entry-row]').count()
    page.locator('#hm-more').scroll_into_view_if_needed()
    expect(page.locator('#hm-more')).to_be_in_viewport(ratio=1)
    page.locator('#page-home').hover()
    page.mouse.wheel(0, 400)
    page.wait_for_function('count=>document.querySelectorAll("#hm-days [data-entry-row]").length>count', arg=previous_count)
    expect(page.locator('#hm-days [data-entry="1"]')).to_have_count(1)
    assert not errors, errors
    assert not external, external
    (OUT / f'metrics-{width}-{theme}.json').write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    context.close()
    print('PASS bounded page opening / 20k rows / 4x CPU', width, theme,
        {name: result['ready_ms'] for name, result in results.items()}, flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        profiles = [(390, 'light')] if os.environ.get('GLEAM_NAVIGATION_SMOKE') == '1' else [
            (360, 'light'), (390, 'light'), (430, 'dark'), (1280, 'light')]
        for width, theme in profiles:
            run(browser, width, theme)
        browser.close()
