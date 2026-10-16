"""账户跨年空月、零额流水、分页及已有账户类型修改（全部虚构数据）。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from test_account_management_ui import SEED, account

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/account-active-months'

def run(page, width):
    page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED)
    page.evaluate("""async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['entries'],'readwrite');
      for(let i=0;i<20;i++)tx.objectStore('entries').put({id:i+1,type:'income',amount:100,accountId:1,
        occurredAt:new Date(2000+i,0,2,12).getTime(),reimburseStatus:'none',deletedAt:0,createdAt:1,updatedAt:1});
      tx.objectStore('entries').put({id:50,type:'income',amount:0,accountId:2,sourceAdjustment:{source:'wacai',rowNo:8},
        occurredAt:new Date(2015,0,2,12).getTime(),reimburseStatus:'none',deletedAt:0,createdAt:1,updatedAt:1});
      await new Promise(r=>tx.oncomplete=r);db.close();
    }""")
    page.reload();page.locator('#fab').wait_for();page.locator('.tab[data-page="page-acct"]').click()
    page.locator('[data-acct="1"]').click();page.locator('.account-month').first.wait_for()
    assert page.locator('.account-month').count()==8
    first=page.locator('.account-month').first
    assert first.get_attribute('data-account-month')=='2019-01'
    assert first.locator('.account-month-head').get_attribute('aria-expanded')=='true'
    assert first.locator('[data-eid="20"]').is_visible()
    first.locator('.account-month-head').click()
    page.locator('#sp-account-detail .balance-trend-heading').click();page.wait_for_timeout(250)
    assert page.locator('.account-month').first.locator('.account-month-head').get_attribute('aria-expanded')=='false'
    page.locator('#sp-account-detail .balance-trend-heading').click()
    load_all=page.locator('[data-account-action="all-months"]')
    earlier=page.locator('[data-account-action="more-months"]')
    load_all.scroll_into_view_if_needed();page.wait_for_timeout(300)
    left=load_all.bounding_box();right=earlier.bounding_box()
    assert left['x'] < right['x'] and abs(left['y']-right['y']) < 1
    assert 44 <= left['height'] <= 48 and 44 <= right['height'] <= 48
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(OUT/f'load-controls-{width}.png'))
    earlier.click()
    page.wait_for_function("document.querySelectorAll('.account-month').length===16")
    page.locator('[data-account-month="2004-01"] .account-month-head').click()
    load_all.click()
    page.wait_for_function("document.querySelectorAll('.account-month').length===20")
    assert page.locator('[data-account-month="2004-01"] .account-month-head').get_attribute('aria-expanded')=='true'
    assert page.locator('[data-account-month="2019-01"] .account-month-head').get_attribute('aria-expanded')=='false'
    assert load_all.count()==0
    assert page.locator('[data-account-action="more-months"]').count()==0
    assert page.locator('[data-account-month="2000-01"]').count()==1
    assert page.locator('.account-month').first.locator('.account-month-balance').inner_text().startswith('100.00')
    page.locator('[data-account-action="edit"]').click()
    page.locator('#sheet [data-g="online"]').click()
    page.locator('#sheet [data-act="close"]').click();page.wait_for_timeout(300)
    assert account(page,1)['group']=='cash', 'cancel changed account'
    page.locator('[data-account-action="edit"]').click()
    page.locator('#sheet [data-g="online"]').click()
    assert page.locator('#sheet [data-g="online"]').bounding_box()['height'] >= 44
    page.wait_for_timeout(300);page.screenshot(path=str(OUT/f'types-{width}.png'))
    page.locator('#sheet [data-act="save"]').click()
    page.locator('#sheet.open').wait_for(state='detached')
    page.wait_for_function("document.querySelector('.account-detail-top')?.textContent.includes('网络账户')")
    assert account(page,1)['balance']==10000
    page.locator('.account-month').first.locator('.account-month-head').click()
    page.wait_for_timeout(300)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(OUT/f'history-{width}.png'))
    page.locator('#sp-account-detail .sub-head [data-act="back"]').click()
    page.locator('#sp-account-detail').wait_for(state='detached')
    assert page.locator('[data-group="online"]').count()==1
    # Reopening resets pagination; load-all also works directly from the first page.
    page.locator('[data-acct="1"]').click();page.locator('[data-account-action="all-months"]').wait_for()
    assert page.locator('.account-month').count()==8
    page.locator('[data-account-action="all-months"]').click()
    page.wait_for_function("document.querySelectorAll('.account-month').length===20")
    assert page.locator('[data-account-action="all-months"], [data-account-action="more-months"]').count()==0
    page.locator('#sp-account-detail .sub-head [data-act="back"]').click()
    page.locator('#sp-account-detail').wait_for(state='detached')
    page.locator('[data-acct="2"]').click();page.locator('.account-month').wait_for()
    assert page.locator('.account-month').count()==1
    assert page.locator('[data-account-action="all-months"]').count()==0
    assert page.locator('[data-eid="50"]').is_visible()
    page.locator('#sp-account-detail .sub-head [data-act="back"]').click()
    page.locator('#sp-account-detail').wait_for(state='detached')
    page.locator('[data-acct="4"]').click()
    page.locator('#sp-account-detail .acct-flow-empty').wait_for()
    assert page.locator('.account-month').count()==0
    assert page.locator('[data-account-action="more-months"]').count()==0
    page.wait_for_timeout(300);page.screenshot(path=str(OUT/f'empty-{width}.png'))

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        for width in (360,390,430,1280):
            context=browser.new_context(viewport={'width':width,'height':900},timezone_id='Asia/Shanghai',service_workers='block')
            page=context.new_page();page.set_default_timeout(10000);errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            run(page,width);assert not errors,errors
            context.close();print(f'PASS account active months {width}',flush=True)
        browser.close()
