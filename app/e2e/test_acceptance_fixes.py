"""Regression gates from the September acceptance audit; all data is fictional."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4601/')
SHOTS=Path(os.environ.get('GLEAM_E2E_SCREENSHOTS',Path(__file__).parents[2]/'.tmp/tests/e2e/screenshots'))
SHOTS.mkdir(parents=True,exist_ok=True)

def seed(page,count=1,amount=10000,received=0,income=False,unsafe=False):
    page.evaluate('''async v=>{
      const db=await new Promise((res,rej)=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
      const tx=db.transaction(['entries','accounts','categories','settings'],'readwrite');
      const now=Date.now();
      const a=tx.objectStore('accounts'),c=tx.objectStore('categories'),e=tx.objectStore('entries');
      a.clear();c.clear();e.clear();
      a.put({id:1,name:v.unsafe?'<b data-audit-mark>虚构账户</b>':'验收现金',group:'cash',balance:-v.count*v.amount+v.received,hidden:false,countInNetWorth:true,sortOrder:1,createdAt:now,updatedAt:now});
      c.put({id:1,name:'验收餐饮',icon:'ic-bowl',kind:'expense',sortOrder:1,createdAt:now,updatedAt:now});
      c.put({id:2,name:'验收午餐',icon:'ic-bowl',kind:'expense',parentId:1,sortOrder:2,createdAt:now,updatedAt:now});
      for(let i=0;i<v.count;i++)e.put({id:i+1,type:'expense',amount:v.amount,occurredAt:now-i*1000,categoryId:2,accountId:1,note:v.unsafe?undefined:'验收虚构账单',reimburseStatus:v.received?'done':'none',reimbursedAmount:v.received||undefined,reimburseAccountId:v.received?1:undefined,reimbursedAt:v.received?now:undefined,deletedAt:0,createdAt:now,updatedAt:now});
      tx.objectStore('settings').put({key:'reimburse.countAsIncome',value:v.income,updatedAt:now});
      await new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});db.close();
    }''',dict(count=count,amount=amount,received=received,income=income,unsafe=unsafe))
    page.reload();page.wait_for_selector('#fab')

def report(page):
    page.locator('.tab[data-page="page-report"]').click();page.locator('#r-spend').wait_for();page.wait_for_timeout(400)

def search(page,keyword='验收'):
    page.locator('#btn-search').click();page.locator('#sr-input').fill(keyword);page.locator('#sr-results [data-eid]').first.wait_for()

def layouts(page,width):
    seed(page,amount=4865025);report(page)
    assert page.locator('#r-seg [data-p="custom"]').evaluate('e=>{const r=document.createRange();r.selectNodeContents(e);return r.getClientRects().length}')==1
    assert page.locator('#r-seg').evaluate('e=>e.getBoundingClientRect().right<=innerWidth')
    for ident in ('#r-spend','#r-income','#r-balance'):
        assert page.locator(ident).evaluate('e=>e.scrollWidth<=e.clientWidth+1'),ident
    page.screenshot(path=str(SHOTS/f'clarity-report-{width}.png'))
    page.locator('.tab[data-page="page-acct"]').click();page.get_by_role('button',name='添加账户',exact=True).click()
    page.locator('#af-balance').click();page.wait_for_timeout(250)
    assert page.locator('#af-balance').get_attribute('inputmode')=='decimal'
    assert page.locator('#af-balance').evaluate('e=>getComputedStyle(e).outlineStyle')=='none'
    page.screenshot(path=str(SHOTS/f'clarity-account-{width}.png'))

def lists(page):
    seed(page,count=101,amount=100);search(page)
    assert '101.00' in page.locator('[data-sf="expense"]').inner_text()
    assert '101.00' in page.locator('.sr-day-head').inner_text()
    if page.locator('#sr-load-more').count(): page.locator('#sr-load-more').click()
    page.wait_for_function('document.querySelectorAll("#sr-results [data-eid]").length === 101')
    assert page.locator('#sr-results [data-eid]').count()==101
    page.locator('[data-sf="income"]').click();page.locator('.sr-empty').wait_for()
    page.locator('[data-sf="all"]').click();page.locator('#sr-results [data-eid]').first.wait_for()

def reimburse(page):
    seed(page,received=6000);report(page)
    assert '40.00' in page.locator('#r-spend').inner_text()
    page.locator('[data-summary-type="expense"]').click();page.locator('.sr-day-head').wait_for()
    assert '40.00' in page.locator('.sr-day-head').inner_text()
    assert '60.00' in page.locator('#sr-results').inner_text()
    page.locator('#sp-search .sub-head [data-act="back"]').click();page.locator('#sp-search').wait_for(state='detached')
    page.locator('.tab[data-page="page-acct"]').click();page.locator('[data-acct]').first.click();page.locator('.account-flow-total').wait_for()
    assert '60.00' in page.locator('.account-flow-total').inner_text()
    # Only months with transactions are listed; this fixture has one active month.
    months=page.locator('.account-month')
    expect(months).to_have_count(1)
    expect(months.first.locator('.account-month-balance .num')).to_have_text('-40.00')
    page.reload();page.wait_for_selector('#fab');seed(page,received=6000,income=True);report(page)
    # 首页时间线也会展示只读到账行；此处验收搜索下钻结果，需限定在搜索结果内。
    page.locator('[data-summary-type="income"]').click();page.locator('#sr-results [data-reimbursement]').wait_for()
    assert '60.00' in page.locator('[data-sf="income"]').inner_text()
    page.locator('#sr-results [data-reimbursement] .entry-swipe-content').click();page.locator('#sp-entry-view.open').wait_for()

def overlays(page):
    page.locator('#fab').click();page.locator('#keypad [data-k="8"]').click();page.locator('#date-chip').click();page.locator('.dw-panel.dw-open').wait_for()
    page.locator('.dw-confirm').focus();page.keyboard.press('Tab')
    assert page.evaluate('!!document.activeElement.closest(".dw-panel")')
    page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))');page.locator('.dw-panel').wait_for(state='detached')
    assert page.locator('#sheet.open').count()==1 and page.locator('#amt').inner_text()=='8'
    page.locator('#date-chip').click();page.locator('.dw-panel.dw-open').wait_for()
    page.wait_for_function('!!document.activeElement.closest(".dw-panel")')
    page.keyboard.press('Escape')
    page.locator('.dw-panel').wait_for(state='detached');assert page.locator('#sheet.open').count()==1

def names(page):
    seed(page,unsafe=True);search(page,'虚构账户')
    assert page.locator('[data-audit-mark]').count()==0
    assert '<b data-audit-mark>' in page.locator('#sr-results').inner_text()

def history(page):
    page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)}),d=new Date();
      const tx=db.transaction('lifeNotes','readwrite');tx.objectStore('lifeNotes').put({id:1,kind:'habit',habitId:1,title:'验收散步打卡',occurredAt:new Date(d.getFullYear(),d.getMonth()-1,15,12).getTime(),createdAt:1,updatedAt:1,deletedAt:0});
      await new Promise(r=>tx.oncomplete=r);db.close();
    }''')
    page.locator('.tab[data-page="page-life"]').click();page.locator('#lf-prev').click();page.wait_for_timeout(400)
    assert '验收散步打卡' in page.locator('#lf-feed').inner_text()

def large_amounts(page):
    seed(page,amount=9988776655);report(page)
    page.evaluate('document.documentElement.style.setProperty("--seed-type", "1.3")')
    for ident in ('#r-spend','#r-income','#r-balance'):
        assert page.locator(ident).evaluate('e=>e.scrollWidth<=e.clientWidth+1'),ident
    page.screenshot(path=str(SHOTS/'clarity-report-large-type.png'))
    assert page.locator('#trend rect[fill="var(--c4)"]').evaluate_all('els=>els.every(e=>Number(e.getAttribute("height"))===0)'), '零收入不应绘制正高度柱'

def dark_theme(page):
    seed(page);report(page)
    page.evaluate('document.documentElement.setAttribute("data-theme","dark")')
    page.wait_for_timeout(250) # 等待主题的颜色过渡完成再截图
    page.screenshot(path=str(SHOTS/'clarity-report-dark.png'))
    assert page.locator('#page-report').evaluate('e=>getComputedStyle(e).color')=='rgb(241, 243, 246)'

if __name__=='__main__':
    failures=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        cases=[(f'layout {w}',lambda page,w=w:layouts(page,w),w) for w in (360,390,430,1024)]
        cases += [(fn.__name__,fn,390) for fn in (lists,reimburse,overlays,names,history,dark_theme)]
        cases += [('large_amounts',large_amounts,360)]
        if os.environ.get('GLEAM_E2E_CASE'): cases=[case for case in cases if case[0]==os.environ['GLEAM_E2E_CASE']]
        for name,fn,width in cases:
            ctx=browser.new_context(viewport={'width':width,'height':844},service_workers='block')
            page=ctx.new_page();page.set_default_timeout(7000)
            try:
                page.goto(URL);page.wait_for_load_state('networkidle');page.wait_for_selector('#fab');fn(page);print('PASS',name,flush=True)
            except Exception as e:
                failures.append(name);print('FAIL',name,str(e),flush=True);page.screenshot(path=str(SHOTS/f'acceptance-{name.replace(" ","-")}-fail.png'))
            finally:ctx.close()
        browser.close()
    raise SystemExit(1 if failures else 0)
