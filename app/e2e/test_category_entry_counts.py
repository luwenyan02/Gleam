"""Category entity counts, hierarchy updates and narrow layouts; fictional data only."""
import os
import time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4602/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/category-entry-counts'
SEED = '''async extra => {
 const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
 const tx=db.transaction(['entries','accounts','categories'],'readwrite');
 for(const name of ['entries','accounts','categories'])tx.objectStore(name).clear();
 const stamp={createdAt:1,updatedAt:1};
 for(const c of [{id:1,name:'交通',kind:'expense'},{id:2,name:'餐饮',kind:'expense'},
   {id:3,name:'公交',kind:'expense',parentId:1},{id:4,name:'停车费',kind:'expense',parentId:1},
   {id:5,name:'工资',kind:'income'},{id:6,name:'虚构未使用分类',kind:'income'},
   {id:7,name:'虚构非常长的交通分类名称用于窄屏检查',kind:'expense',parentId:1}])
   tx.objectStore('categories').put({...stamp,icon:'ic-tag',sortOrder:c.id,...c});
 for(let id=20;id<36;id++)tx.objectStore('categories').put({...stamp,id,name:`虚构备用小类${id}`,kind:'expense',parentId:1,icon:'ic-tag',sortOrder:id});
 tx.objectStore('accounts').put({...stamp,id:1,name:'虚构现金',group:'cash',balance:100000,hidden:false,sortOrder:1});
 const rows=[{categoryId:1},{categoryId:3},{categoryId:3,refundFlag:true},{categoryId:4,amount:-50},
   {categoryId:4,deletedAt:2},{categoryId:5,type:'income',occurredAt:new Date(2000,0,1).getTime()},
   {categoryId:5,type:'income',occurredAt:new Date(2060,0,1).getTime()},
   {categoryId:3,reimburseStatus:'done',reimbursedAmount:50,reimburseAccountId:1,reimbursedAt:Date.now()},
   {type:'transfer',categoryId:undefined,fromAccountId:1,toAccountId:1},
   {type:'loan',categoryId:undefined,loanKind:'collect'},
   {categoryId:5,type:'income',deletedAt:2},{categoryId:7,amount:0}];
 rows.forEach((r,i)=>tx.objectStore('entries').put({...stamp,id:i+1,type:'expense',accountId:1,amount:100,occurredAt:Date.now(),deletedAt:0,reimburseStatus:'none',...r}));
 for(let i=0;i<extra;i++)tx.objectStore('entries').put({...stamp,id:100+i,type:'expense',categoryId:7,accountId:1,amount:1,occurredAt:new Date(2000,0,1).getTime(),deletedAt:0,reimburseStatus:'none'});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}'''


def count(page, category_id, expected):
    expect(page.locator(f'#cm-list [data-category-count="{category_id}"]')).to_have_text(f'{expected:,} 笔')


def run(browser, width, theme, scale, extra):
    context=browser.new_context(viewport={'width':width,'height':890},device_scale_factor=3 if width==400 else 1,
                               locale='zh-CN',timezone_id='Asia/Shanghai',service_workers='block',reduced_motion='reduce')
    context.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc==urlsplit(URL).netloc else r.abort())
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED,extra);page.reload();page.locator('#fab').wait_for()
    page.evaluate('([t,s])=>{document.documentElement.dataset.theme=t;document.documentElement.style.setProperty("--seed-type",String(s))}',[theme,scale])
    page.locator('[data-page="page-mine"]').click();started=time.monotonic();page.locator('[data-sub="sp-categories"]').click()
    for cid,n in [(1,6+extra),(2,0),(3,3),(4,1),(7,1+extra)]:count(page,cid,n)
    elapsed=time.monotonic()-started;assert elapsed<10,elapsed
    for label in page.locator('#cm-list .cm-category-label').all():
        name=label.locator('.cm-category-name').bounding_box();badge=label.locator('.cm-entry-count').bounding_box()
        assert name['x']+name['width']+6<=badge['x']+1
        assert label.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    for parent in page.locator('#cm-list .cm-parent-copy').all():
        badge=parent.locator('.cm-entry-count').bounding_box();children=parent.locator('.cm-subcount').bounding_box()
        assert abs(badge['y']-children['y'])<1.1
        assert badge['x']+badge['width']+6<=children['x']+1
        assert parent.locator('.cm-category-name').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
        assert parent.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    assert page.locator('#sp-categories').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    label=f'{width}-{theme}-text{scale}'
    page.screenshot(path=str(OUT/f'expense-{label}.png'),animations='disabled')
    for _ in range(3):
        page.locator('#cm-seg [data-t="income"]').click();page.locator('#cm-seg [data-t="expense"]').click()
    page.locator('#cm-seg [data-t="income"]').click();count(page,5,2);count(page,6,0)
    expect(page.locator('#cm-list [data-category-count]')).to_have_count(2)
    page.screenshot(path=str(OUT/f'income-{label}.png'),animations='disabled')
    page.locator('#cm-seg [data-t="expense"]').click();count(page,7,1+extra)
    # Editing and moving preserve the child's count and update both parent totals.
    page.locator('#cm-list [data-id="7"]').click();page.locator('#cf-move [data-move="2"]').click();page.locator('#sheet [data-act="save"]').click()
    page.locator('#sheet.open').wait_for(state='detached');count(page,1,5);count(page,2,1+extra);count(page,7,1+extra)
    # Existing merge flow must refresh the newly displayed counts too.
    page.locator('#cm-merge').click();page.locator('[data-merge-category="3"]').click();page.locator('[data-merge-category="4"]').click();page.locator('[data-merge-confirm]').click()
    page.locator('#sheet.open').wait_for(state='detached');expect(page.locator('#cm-list [data-id="3"]')).to_have_count(0)
    count(page,4,4);count(page,1,5);count(page,2,1+extra)
    assert not errors,errors
    context.close();print('PASS category counts, move, merge and rapid tabs',label,{'extra_entries':extra,'load_seconds':round(elapsed,3)},flush=True)


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width,theme,scale,extra in [(360,'light',1,0),(390,'dark',1,0),(400,'light',1,0),(400,'dark',1.3,20000),(430,'light',1,0),(1280,'dark',1,0)]:
            run(browser,width,theme,scale,extra)
        browser.close()
