"""编译版保存故障回归：在隔离浏览器模拟底层 IndexedDB 写入异常。"""
import os
from playwright.sync_api import sync_playwright
from test_acceptance_fixes import seed

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4601/')

def snapshot(page):
    return page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['entries','accounts','lifeNotes','merchants']);
      const read=n=>new Promise(r=>{const q=tx.objectStore(n).getAll();q.onsuccess=()=>r(q.result)});
      const [entries,accounts,notes,merchants]=await Promise.all(['entries','accounts','lifeNotes','merchants'].map(read));
      db.close();return {entries,accounts,notes,merchants};
    }''')

def fail_once(page,store):
    page.evaluate('''store=>{
      let pending=true;
      for(const method of ['add','put']){
        const original=IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method]=function(...args){
          if(this.name===store&&pending){pending=false;throw new DOMException('虚构写入故障','QuotaExceededError')}
          return Reflect.apply(original,this,args);
        };
      }
    }''',store)

def run(page,store):
    seed(page,count=0)
    page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction('merchants','readwrite');
      tx.objectStore('merchants').clear();tx.objectStore('merchants').put({id:1,name:'虚构原子保存店',useCount:0,createdAt:1,updatedAt:1});
      await new Promise(r=>tx.oncomplete=r);db.close();
    }''')
    page.locator('#fab').click();page.locator('#keypad [data-k="1"]').click();page.locator('#keypad [data-k="2"]').click()
    page.locator('[data-act="toggle-advanced"]').click();page.locator('#life-toggle').click()
    page.locator('#chip-shop').click();page.locator('.picker-item[data-value="1"]').click();page.locator('.picker-mask').wait_for(state='detached')
    fail_once(page,store)
    page.locator('#keypad [data-k="save"]').click()
    page.wait_for_function("document.querySelector('#toast')?.innerText.includes('虚构写入故障')")
    failed=snapshot(page)
    assert failed['entries']==[],'失败后不应有已入账流水'
    assert failed['notes']==[],'失败后不应留下孤立生活记录'
    assert failed['accounts'][0]['balance']==0,'失败后不应改变余额'
    page.locator('#keypad [data-k="save"]').click();page.locator('#sheet.open').wait_for(state='detached')
    saved=snapshot(page)
    assert len(saved['entries'])==len(saved['notes'])==1
    assert saved['entries'][0]['lifeNoteId']==saved['notes'][0]['id']
    assert saved['accounts'][0]['balance']==-1200
    assert saved['merchants'][0]['useCount']==1

if __name__=='__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        try:
            for store in ('merchants','entries'):
                ctx=browser.new_context(viewport={'width':390,'height':844},service_workers='block')
                page=ctx.new_page();page.set_default_timeout(7000)
                try:
                    page.goto(URL);page.wait_for_load_state('networkidle');page.locator('#fab').wait_for()
                    run(page,store);print('PASS atomic save',store,flush=True)
                finally:ctx.close()
        finally:browser.close()
