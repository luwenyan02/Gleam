"""Entry memory starts with facts, keeps drafts, and never posts a second ledger entry."""
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4602/')
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/entry-life-memory'
EXPECTED='2026年10月17日 22:08，在「虚构烤鱼店」消费159元（夜宵），用「微信」支付。\n备注：朋友聚餐'
SEED='''async()=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
 const names=['entries','accounts','categories','merchants','lifeNotes','lifeDrafts','settings'];const tx=db.transaction(names,'readwrite');
 for(const name of names.filter(n=>n!=='settings'))tx.objectStore(name).clear();
 const stamp={createdAt:1,updatedAt:1};
 tx.objectStore('accounts').put({...stamp,id:1,name:'微信',group:'online',balance:100000,hidden:false,sortOrder:1});
 tx.objectStore('categories').put({...stamp,id:1,name:'夜宵',kind:'expense',icon:'ic-moon',sortOrder:1});
 tx.objectStore('merchants').put({...stamp,id:1,name:'虚构烤鱼店',useCount:1});
 tx.objectStore('entries').put({...stamp,id:1,type:'expense',amount:15900,occurredAt:new Date(2026,9,17,22,8).getTime(),categoryId:1,accountId:1,merchantId:1,note:'朋友聚餐；收付款人：虚构昵称',deletedAt:0,reimburseStatus:'none'});
 tx.objectStore('settings').put({key:'life.aiEnabled',value:false});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}'''
READ='''async()=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
 const names=['entries','accounts','lifeNotes','lifeDrafts'];const tx=db.transaction(names,'readonly');
 const rows=await Promise.all(names.map(name=>new Promise(resolve=>{const r=tx.objectStore(name).getAll();r.onsuccess=()=>resolve([name,r.result])})));
 db.close();return Object.fromEntries(rows);
}'''


def open_memory(page):
    page.locator('[data-entry-life]').click()
    expect(page.locator('#lc-body')).to_be_visible()


def close_memory(page):
    page.locator('[data-lc-close]').click()
    page.locator('#sheet.open').wait_for(state='detached')


def run(browser,width,scale,theme):
    context=browser.new_context(viewport={'width':width,'height':890},device_scale_factor=3 if width==400 else 1,
                               locale='zh-CN',timezone_id='Asia/Shanghai',service_workers='block',reduced_motion='reduce')
    external=[];errors=[]
    context.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc==urlsplit(URL).netloc else (external.append(r.request.url),r.abort()))
    page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    page.clock.set_fixed_time(datetime.fromisoformat('2026-10-18T12:00:00+08:00'))
    page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED);page.reload();page.locator('#fab').wait_for()
    page.evaluate('([t,s])=>{document.documentElement.dataset.theme=t;document.documentElement.style.setProperty("--seed-type",String(s))}',[theme,scale])
    before=page.evaluate(READ)
    page.locator('#hm-days [data-entry="1"]').click();page.locator('[data-entry-life]').wait_for();open_memory(page)
    expect(page.locator('#lc-body')).to_have_value(EXPECTED)
    expect(page.locator('[data-lc-detach],.lc-linked')).to_have_count(0)
    expect(page.locator('#sheet')).not_to_contain_text('仅保存故事')
    assert page.locator('#sheet').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    label=f'{width}-{theme}-text{scale}'
    page.screenshot(path=str(OUT/f'prefill-{label}.png'),animations='disabled')
    final_body=EXPECTED
    if width!=360:
        final_body=EXPECTED+'\n那晚聊了很久。'
        page.locator('#lc-body').fill(final_body);close_memory(page);open_memory(page)
        expect(page.locator('#lc-body')).to_have_value(final_body)
        page.locator('#lc-body').fill('');close_memory(page);open_memory(page)
        expect(page.locator('#lc-body')).to_have_value('')
        page.locator('#lc-body').fill(final_body)
    page.locator('[data-lc-save]').click();page.locator('#sheet.open').wait_for(state='detached')
    after=page.evaluate(READ)
    assert len(after['entries'])==len(before['entries'])==1
    assert len(after['lifeNotes'])==1
    assert after['accounts']==before['accounts']
    original=before['entries'][0];linked=after['entries'][0];note=after['lifeNotes'][0]
    assert {k:v for k,v in linked.items() if k not in ['updatedAt','lifeNoteId']}=={k:v for k,v in original.items() if k not in ['updatedAt','lifeNoteId']}
    assert linked['lifeNoteId']==note['id'];assert note['body']==final_body
    assert note['occurredAt']==original['occurredAt']
    assert not any(d['key']=='entry:1' for d in after['lifeDrafts'])
    # Reopen the saved story: original wording must not be replaced or appended again.
    open_memory(page);expect(page.locator('#lc-body')).to_have_value(final_body);close_memory(page)
    assert len(page.evaluate(READ)['lifeNotes'])==1
    page.locator('#sp-entry-view .sub-head [data-act="back"]').click()
    page.locator('[data-page="page-life"]').click();page.locator('[data-life-capture]').click()
    expect(page.locator('#lc-body')).to_have_value('');close_memory(page)
    assert not errors,errors;assert not external,external
    context.close();print('PASS automatic entry memory, editable facts, empty/resumed drafts and unchanged ledger',label,flush=True)


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width,scale,theme in [(360,1,'light'),(390,1,'dark'),(400,1,'light'),(400,1.3,'dark'),(430,1,'light'),(1280,1,'dark')]:
            run(browser,width,scale,theme)
        browser.close()
