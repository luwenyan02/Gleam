"""Advanced filter width, category hierarchy and account-group selection; fictional data."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4617/')
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/search-filter-groups'
SEED='''async()=>{
 const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
 const tx=db.transaction(['entries','categories','accounts'],'readwrite'),stamp={createdAt:1,updatedAt:1};
 for(const name of ['entries','categories','accounts'])tx.objectStore(name).clear();
 for(const [id,name,kind,parentId,sortOrder]of [[8001,'虚构餐饮','expense',null,1],[8002,'早餐','expense',8001,20],
  [8003,'午餐','expense',8001,2],[8010,'交通','expense',null,3],[8011,'长名称公交地铁公共交通类别','expense',8010,4],
  [8020,'独立分类','expense',null,5],[8101,'工资收入','income',null,6]])
  tx.objectStore('categories').put({...stamp,id,name,kind,sortOrder,...(parentId?{parentId}:{})});
 for(const [id,name,group,hidden]of [[9001,'虚构现金一','cash',false],[9002,'虚构现金二','cash',true],
  [9003,'虚构长名称储蓄卡账户用于检查自动换行','debit',false],[9004,'虚构信用卡','credit',false]])
  tx.objectStore('accounts').put({...stamp,id,name,group,hidden,balance:100000,countInNetWorth:true,sortOrder:id});
 for(let i=0;i<133;i++)tx.objectStore('categories').put({...stamp,id:8200+i,name:'虚构交通小类'+i,
  kind:'expense',parentId:8010,sortOrder:100+i});
 for(let i=0;i<56;i++)tx.objectStore('accounts').put({...stamp,id:9200+i,name:'虚构储蓄账户'+i,
  group:'debit',hidden:false,balance:0,countInNetWorth:true,sortOrder:100+i});
 for(const [id,categoryId,accountId,type]of [[1,8002,9001,'expense'],[2,8003,9002,'expense'],[3,8001,9003,'expense'],
  [4,8011,9004,'expense'],[5,8020,9003,'expense'],[6,8101,9001,'income']])
  tx.objectStore('entries').put({...stamp,id,type,categoryId,accountId,amount:100,occurredAt:Date.now()-id*1000,
   note:'虚构分组筛选',deletedAt:0,reimburseStatus:'none'});
 await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=()=>j(tx.error)});db.close();
}'''


def results(page, ids):
    page.wait_for_function('expected=>JSON.stringify([...document.querySelectorAll("#sr-results [data-eid]")].map(e=>Number(e.dataset.eid)).sort((a,b)=>a-b))===JSON.stringify(expected)',arg=ids)
    expect(page.locator('#sr-results [data-eid]')).to_have_count(len(ids))
    assert sorted(page.locator('#sr-results [data-eid]').evaluate_all('els=>els.map(e=>Number(e.dataset.eid))'))==ids


def open_panel(page, section):
    page.locator('#sr-adv-filter').click()
    expect(page.locator('.fp-cancel')).to_be_focused()
    page.locator(f'.fp-panel [data-expand="{section}"]').click()


def confirm(page):
    page.locator('.fp-ok').click();page.locator('.fp-panel').wait_for(state='detached')


def same_width(page, selector):
    sizes=page.locator(selector).evaluate('el=>{const b=e=>e.getBoundingClientRect().toJSON();return [b(el),b(document.querySelector(".app"))]}')
    assert abs(sizes[0]['width']-sizes[1]['width'])<1 and abs(sizes[0]['left']-sizes[1]['left'])<1,sizes


def run(browser,width,theme,scale):
    context=browser.new_context(viewport={'width':width,'height':844},timezone_id='Asia/Shanghai',
                                service_workers='block',reduced_motion='reduce')
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED);page.reload();page.locator('#fab').wait_for()
    page.evaluate('([s,t])=>{document.documentElement.style.setProperty("--seed-type",s);document.documentElement.dataset.theme=t}',[str(scale),theme])
    # Open calendar first: it must load filter styles without first visiting search.
    page.locator('#hm-quick .hm-all').click();page.get_by_text('日历',exact=True).last.click()
    page.locator('.picker-mask').wait_for(state='detached')
    page.locator('#sp-calendar [data-act="filter"]').click();expect(page.locator('.fp-cancel')).to_be_focused()
    same_width(page,'.fp-panel');page.locator('.fp-panel [data-expand="account"]').click()
    OUT.mkdir(parents=True,exist_ok=True)
    page.screenshot(path=str(OUT/f'calendar-{width}-{theme}-{scale}.png'),animations='disabled')
    page.locator('.fp-cancel').click();page.locator('.fp-panel').wait_for(state='detached')
    page.locator('#sp-calendar .sub-head [data-act="back"]').click()
    page.locator('#btn-search').click();page.locator('#sr-input').fill('虚构分组筛选');results(page,[1,2,3,4,5,6])
    open_panel(page,'category')
    geometry=page.locator('.fp-panel').evaluate('el=>{const b=e=>e.getBoundingClientRect().toJSON();return {panel:b(el),app:b(document.querySelector(".app")),footer:b(el.querySelector(".fp-footer"))}}')
    assert abs(geometry['panel']['width']-geometry['app']['width'])<1,geometry
    assert abs(geometry['panel']['left']-geometry['app']['left'])<1,geometry
    assert geometry['footer']['bottom']<=844,geometry
    dining=page.locator('[data-category-group="8001"]')
    dining.click();expect(dining).to_have_attribute('aria-checked','true')
    for cid in [8002,8003]:expect(page.locator(f'[data-cid="{cid}"]')).to_have_attribute('aria-pressed','true')
    order=page.locator('.fp-category-group').first.locator('[data-cid]').evaluate_all('els=>els.map(e=>Number(e.dataset.cid))')
    assert order==[8003,8002],order
    confirm(page);results(page,[1,2,3])  # Include historical entries recorded directly on the parent.
    open_panel(page,'category');page.locator('[data-cid="8003"]').click()
    expect(dining).to_have_attribute('aria-checked','mixed')
    OUT.mkdir(parents=True,exist_ok=True)
    page.screenshot(path=str(OUT/f'category-{width}-{theme}-{scale}.png'),animations='disabled')
    assert page.locator('.fp-panel').evaluate('el=>el.scrollWidth<=el.clientWidth+1')
    assert page.locator('.fp-body').evaluate('el=>el.scrollHeight>el.clientHeight')
    assert page.locator('.fp-panel button').evaluate_all('els=>els.filter(e=>e.getClientRects().length).every(e=>e.getBoundingClientRect().height>=44)')
    confirm(page);results(page,[1])  # The unchecked child must not be reintroduced by parent expansion.
    open_panel(page,'category');dining.click();dining.click()
    expect(dining).to_have_attribute('aria-checked','false')
    page.keyboard.press('Escape');page.locator('.fp-panel').wait_for(state='detached');results(page,[1])
    open_panel(page,'category');page.locator('.fp-reset').click();confirm(page);results(page,[1,2,3,4,5,6])
    open_panel(page,'account');cash=page.locator('[data-account-group="cash"]');cash.click()
    expect(cash).to_have_attribute('aria-checked','true')
    expect(page.locator('[data-aid="9002"]')).to_contain_text('已隐藏')
    page.screenshot(path=str(OUT/f'account-{width}-{theme}-{scale}.png'),animations='disabled')
    confirm(page);results(page,[1,2,6])
    open_panel(page,'account');page.locator('[data-aid="9002"]').click()
    expect(cash).to_have_attribute('aria-checked','mixed');confirm(page);results(page,[1,6])
    open_panel(page,'account');page.locator('[data-aid="9001"]').click()
    expect(cash).to_have_attribute('aria-checked','false')
    page.locator('.fp-cancel').click();results(page,[1,6])
    # Reset both filters, then combine category and account groups.
    open_panel(page,'category');page.locator('.fp-reset').click();page.locator('[data-expand="category"]').click()
    dining.click();page.locator('[data-expand="account"]').click();cash.click();confirm(page);results(page,[1,2])
    open_panel(page,'account');page.locator('.fp-reset').click();page.locator('[data-expand="account"]').click()
    page.locator('[data-account-group="debit"]').click();confirm(page);results(page,[3,5])
    # Audit the other body-mounted search selectors and the shared calendar panel.
    page.locator('#sr-field-btn').click();page.locator('.sr-field-sheet.open').wait_for()
    same_width(page,'.sr-field-sheet');page.locator('.sr-field-sheet .fs-close').click()
    page.locator('.sr-field-sheet').wait_for(state='detached')
    page.locator('#sr-dates [data-range="custom"]').click();page.locator('.dw-panel').wait_for()
    same_width(page,'.dw-panel');page.locator('.dw-mask').click(position={'x':5,'y':5})
    page.locator('.dw-panel').wait_for(state='detached')
    assert not errors,errors
    context.close();print('PASS search filter groups',width,theme,scale,flush=True)


if __name__=='__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for profile in [(1280,'light',1),(360,'light',1),(390,'light',1),(430,'dark',1),(400,'light',1.3),(400,'dark',1.3)]:
            run(browser,*profile)
        browser.close()
