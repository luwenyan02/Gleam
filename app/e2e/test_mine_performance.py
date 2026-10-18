"""First Mine paint and bounded value reads with 20k fictional rows and slow native metadata."""
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4617/')
BASELINE=os.environ.get('GLEAM_MINE_BASELINE')=='1'
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/mine-performance'
AUDIT='''() => {
 window.__mineReads={active:false,keys:0,values:0};
 for (const proto of [IDBIndex.prototype,IDBObjectStore.prototype]) for(const method of ['getAll','getAllKeys','openCursor','openKeyCursor']) {
  const original=proto[method];if(!original)continue;
  proto[method]=function(...args) {
   const request=original.apply(this,args), name=this.objectStore?.name??this.name;
   if(name==='entries'&&window.__mineReads.active) request.addEventListener('success',()=>{
    const result=request.result, size=Array.isArray(result)?result.length:result?1:0;
    window.__mineReads[method.includes('Keys')||method.includes('KeyCursor')?'keys':'values']+=size;
   });return request;
  };
 }
}'''
SEED='''async()=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
 const tx=db.transaction(['entries','budgets','categories','accounts'],'readwrite');
 const categories=await new Promise(resolve=>{const r=tx.objectStore('categories').getAll();r.onsuccess=()=>resolve(r.result)});
 const accounts=await new Promise(resolve=>{const r=tx.objectStore('accounts').getAll();r.onsuccess=()=>resolve(r.result)});
 const categoryId=categories.find(c=>c.kind==='expense'&&c.parentId!=null).id, accountId=accounts.find(a=>a.group==='cash').id;
 tx.objectStore('entries').clear();tx.objectStore('budgets').clear();
 for(let id=1;id<=20000;id++)tx.objectStore('entries').put({id,type:'expense',amount:1000,categoryId,accountId,
  occurredAt:id<=20?Date.now()-id*1000:new Date(2020,0,1).getTime()+id*1000,
  note:'虚构性能记录'.repeat(60),reimburseStatus:id>=19999?'pending':'none',deletedAt:0,createdAt:1,updatedAt:1});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}'''

def run(browser,width,theme):
    context=browser.new_context(viewport={'width':width,'height':890},timezone_id='Asia/Shanghai',service_workers='block')
    context.add_init_script(MOCK_NATIVE+''';(() => {
      const original=window.Capacitor.nativePromise.bind(window.Capacitor);
      window.Capacitor.nativePromise=async(plugin,method,...args)=>{
        if(plugin==='App'&&method==='getInfo')await new Promise(resolve=>setTimeout(resolve,1200));
        return original(plugin,method,...args);
      };
    })();''')
    page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED);page.reload();page.locator('#hm-days [data-entry="1"]').wait_for()
    page.wait_for_timeout(700);page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
    page.evaluate(AUDIT)
    session=context.new_cdp_session(page);session.send('Emulation.setCPUThrottlingRate',{'rate':4})
    result=page.evaluate('''()=>new Promise(resolve=>{
      window.__mineReads.active=true;const start=performance.now();
      const observer=new MutationObserver(()=>{
        if(document.querySelector('#page-mine .mine-head')){observer.disconnect();resolve({ready_ms:Math.round(performance.now()-start)});}
      });observer.observe(document.querySelector('#page-mine'),{childList:true,subtree:true});
      document.querySelector('[data-page="page-mine"]').click();
    })''')
    expect(page.locator('#page-mine .mine-head')).to_contain_text('20000 条流水')
    expect(page.locator('#page-mine [data-sub="sp-reimburse"] .row-note')).to_contain_text('2 笔')
    expect(page.locator('#page-mine [data-app-version]')).to_contain_text('Android')
    page.wait_for_timeout(150)
    result.update(page.evaluate('()=>{window.__mineReads.active=false;return window.__mineReads}'))
    if not BASELINE:
        assert result['ready_ms']<350,result
        assert result['values']<=4 and result['keys']==20000,result
        # Dynamic summaries must not replace focused entry buttons.
        page.locator('#page-mine [data-help-manual]').focus()
        page.wait_for_timeout(50)
        expect(page.locator('#page-mine [data-help-manual]')).to_be_focused()
    assert not errors,errors
    label=f'{width}-{theme}-'+('before' if BASELINE else 'after')
    page.screenshot(path=str(OUT/(label+'.png')),animations='disabled')
    (OUT/(label+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print('PASS Mine first paint, 20k rows / 4x CPU / 1200ms metadata',label,result,flush=True)
    context.close()

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        cases=[(390,'light')] if BASELINE or os.environ.get('GLEAM_MINE_SMOKE')=='1' else [(360,'light'),(390,'light'),(430,'dark'),(1280,'light')]
        for width,theme in cases:run(browser,width,theme)
        browser.close()
