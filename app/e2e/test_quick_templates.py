"""Template account presets and the isolated home picker; fictional data only."""
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from test_ux_m1 import assert_advanced_action_row

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4617/')
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/quick-templates'


def seed(page,theme):
    page.evaluate('''async theme=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      const tx=db.transaction(['accounts','categories','quickTemplates','entries','settings'],'readwrite');
      const categories=await new Promise(resolve=>{const r=tx.objectStore('categories').getAll();r.onsuccess=()=>resolve(r.result)});
      const categoryId=categories.find(c=>c.kind==='expense').id;
      const times={createdAt:Date.now(),updatedAt:Date.now()};
      tx.objectStore('accounts').clear();tx.objectStore('entries').clear();tx.objectStore('quickTemplates').clear();
      for(const [id,name,group,balance] of [[880,'虚构现金','cash',95000],[881,'虚构银行卡','debit',1000000]]){
        tx.objectStore('accounts').put({id,name,group,balance,hidden:false,countInNetWorth:true,creditReminderEnabled:true,sortOrder:id,...times});
      }
      tx.objectStore('quickTemplates').put({id:810,name:'旧模板早餐',amount:1500,categoryId,sortOrder:0,...times});
      tx.objectStore('quickTemplates').put({id:811,name:'午餐演示',amount:5600,categoryId,accountId:881,sortOrder:1,...times});
      for(let i=0;i<40;i++)tx.objectStore('quickTemplates').put({id:900+i,name:`虚构模板${i}`,amount:100+i,categoryId,sortOrder:i+2,...times});
      for(let i=0;i<50;i++)tx.objectStore('entries').put({id:2000+i,type:'expense',amount:100,categoryId,accountId:880,occurredAt:Date.now()-i*86400000,reimburseStatus:'none',deletedAt:0,note:`虚构日常账单${i}`,...times});
      tx.objectStore('settings').put({key:'entry.lastUsed',value:{accountId:880,expenseCategoryId:categoryId,type:'expense'},updatedAt:Date.now()});
      tx.objectStore('settings').put({key:'theme.mode',value:theme,updatedAt:Date.now()});
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
      localStorage.setItem('gleam-theme',theme);
    }''',theme)
    page.reload()
    page.locator('#fab').wait_for()


def picker(page,query=''):
    page.locator('#hm-quick [data-qa="note"]').click()
    page.get_by_role('dialog',name='选择速记模板',exact=True).wait_for()
    page.locator('.picker-search input').fill(query)
    return page.locator('.picker-mask')


def screenshot(page,name,width,theme):
    page.wait_for_timeout(250)
    page.screenshot(path=str(OUT/f'{name}-{width}-{theme}.png'),animations='disabled')


def run(page,width,theme):
    seed(page,theme)
    page.wait_for_function('document.querySelector("#page-home").scrollHeight>1000')
    page.locator('#page-home').evaluate('e=>e.scrollTop=100')
    mask=picker(page)
    expect(page.locator('.viewport')).to_have_attribute('inert','')
    assert page.locator('#page-home').evaluate('e=>!!e.closest("[inert]")')
    assert mask.evaluate('e=>e.parentElement.classList.contains("app")')
    app=page.locator('.app').bounding_box();box=mask.bounding_box()
    assert abs(box['y']-app['y'])<1 and abs(box['height']-app['height'])<1
    action=page.get_by_role('button',name='速记模板设置',exact=True)
    search=page.locator('.picker-search input').bounding_box();button=action.bounding_box()
    assert button['x']>=search['x']+search['width']+4
    assert button['width']>=44 and button['height']>=44
    assert action.inner_text()=='' and action.locator('use').get_attribute('href')=='#ic-set'
    home_scroll=page.locator('#page-home').evaluate('e=>e.scrollTop')
    panel=page.locator('.picker-panel').bounding_box()
    listing=page.locator('.picker-list')
    assert listing.evaluate('e=>e.scrollHeight>e.clientHeight')
    bounds=listing.bounding_box();page.mouse.move(bounds['x']+bounds['width']/2,bounds['y']+bounds['height']/2)
    page.mouse.wheel(0,1200);page.wait_for_timeout(200)
    assert listing.evaluate('e=>e.scrollTop>0')
    listing.evaluate('e=>e.scrollTop=e.scrollHeight')
    page.mouse.wheel(0,1200);page.wait_for_timeout(200)
    assert page.locator('#page-home').evaluate('e=>e.scrollTop')==home_scroll
    assert abs(page.locator('.picker-panel').bounding_box()['y']-panel['y'])<1
    screenshot(page,'picker',width,theme)
    page.locator('.picker-search input').fill('旧模板早餐')
    expect(page.locator('.picker-item')).to_have_count(1)
    page.locator('.picker-item').click()
    mask.wait_for(state='detached')
    expect(page.locator('#amt')).to_have_text('15')
    expect(page.locator('#acct-name')).to_have_text('虚构现金')
    page.locator('[data-act="toggle-advanced"]').click()
    assert_advanced_action_row(page)
    screenshot(page,'entry',width,theme)
    page.locator('#sheet-close').click()
    picker(page,'午餐演示')
    page.locator('.picker-item').click();page.locator('.picker-mask').wait_for(state='detached')
    expect(page.locator('#amt')).to_have_text('56')
    expect(page.locator('#acct-name')).to_have_text('虚构银行卡')
    page.locator('#cat-grid .cat[data-id]').nth(1).click()
    expect(page.locator('#acct-name')).to_have_text('虚构银行卡')
    page.locator('#keypad [data-k="save"]').click()
    page.locator('#sheet.open').wait_for(state='detached')
    saved=page.evaluate('''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('entries');const rows=await new Promise(resolve=>{const r=tx.objectStore('entries').getAll();r.onsuccess=()=>resolve(r.result)});db.close();return rows.at(-1);
    }''')
    assert saved['accountId']==881 and saved['amount']==5600
    picker(page,'没有匹配的模板')
    expect(page.locator('.picker-item')).to_have_count(0)
    page.get_by_role('button',name='速记模板设置',exact=True).click()
    page.locator('.picker-mask').wait_for(state='detached')
    page.locator('#sp-template-manage.open').wait_for()
    assert page.evaluate('history.state.gleamSubDepth')==1
    page.locator('#tm-add').click();page.locator('#tf-name').fill('新模板演示')
    page.locator('#tf-amount').fill('12.5')
    page.locator('#tf-account').click()
    page.locator('.picker-item',has_text='虚构银行卡').click()
    page.locator('.picker-mask').wait_for(state='detached')
    expect(page.locator('#tf-name')).to_have_value('新模板演示')
    expect(page.locator('#tf-amount')).to_have_value('12.5')
    expect(page.locator('#tf-account')).to_contain_text('虚构银行卡')
    page.locator('#tf-cats [data-cat]').first.click()
    screenshot(page,'form',width,theme)
    page.locator('#sheet [data-act="save"]').click()
    page.locator('#sheet.open').wait_for(state='detached')
    row=page.locator('.tm-item',has_text='新模板演示')
    expect(row).to_contain_text('虚构银行卡')
    row.click();page.locator('#tf-account').click()
    page.locator('.picker-item',has_text='自动选择').click()
    page.locator('.picker-mask').wait_for(state='detached')
    page.locator('#sheet [data-act="save"]').click()
    page.locator('#sheet.open').wait_for(state='detached')
    expect(page.locator('.tm-item',has_text='新模板演示')).to_contain_text('自动选择账户')
    page.go_back();page.locator('#sp-template-manage').wait_for(state='detached')
    assert not page.locator('.viewport').evaluate('e=>e.inert')
    # An explicitly configured account stays selected after it is hidden.
    page.evaluate('''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('accounts','readwrite');const store=tx.objectStore('accounts');
      const bank=await new Promise(resolve=>{const r=store.get(881);r.onsuccess=()=>resolve(r.result)});store.put({...bank,hidden:true});
      await new Promise(resolve=>tx.oncomplete=resolve);db.close();
    }''')
    page.reload();page.locator('#fab').wait_for();picker(page,'午餐演示')
    page.locator('.picker-item').click();page.locator('.picker-mask').wait_for(state='detached')
    expect(page.locator('#acct-name')).to_have_text('虚构银行卡')
    page.locator('#sheet-close').click()
    # A single template must still expose its search and settings controls.
    page.evaluate('''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('quickTemplates','readwrite');const store=tx.objectStore('quickTemplates');
      const old=await new Promise(resolve=>{const r=store.get(810);r.onsuccess=()=>resolve(r.result)});store.clear();store.put(old);
      await new Promise(resolve=>tx.oncomplete=resolve);db.close();
    }''')
    page.reload();page.locator('#fab').wait_for();picker(page)
    expect(page.locator('.picker-item')).to_have_count(1)
    expect(page.get_by_role('button',name='速记模板设置',exact=True)).to_be_visible()
    page.locator('.picker-item').click();page.locator('.picker-mask').wait_for(state='detached')
    expect(page.locator('#acct-name')).to_have_text('虚构现金')
    page.locator('#sheet-close').click();picker(page)
    page.keyboard.press('Escape');page.locator('.picker-mask').wait_for(state='detached')
    assert page.locator('#page-home').evaluate('e=>!e.closest("[inert]")')
    print(f'PASS quick templates {width} {theme}: account CRUD/pre-fill/save, legacy, isolated scroll and settings',flush=True)


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    widths=tuple(map(int,os.environ.get('GLEAM_UI_WIDTHS','360,390,430,1280').split(',')))
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width in widths:
            for theme in ('light','dark'):
                context=browser.new_context(viewport={'width':width,'height':844},locale='zh-CN',timezone_id='Asia/Shanghai',service_workers='block',reduced_motion='reduce')
                origin=urlsplit(URL).netloc
                context.route('**/*',lambda route:route.continue_() if urlsplit(route.request.url).netloc==origin else route.abort())
                page=context.new_page();errors=[]
                page.on('pageerror',lambda error:errors.append(str(error)))
                try:
                    page.goto(URL);page.locator('#fab').wait_for();run(page,width,theme)
                    assert not errors,errors
                finally:context.close()
        browser.close()


if __name__=='__main__':main()
