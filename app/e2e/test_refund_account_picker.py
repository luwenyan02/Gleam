"""Refunds reuse the entry account picker, keeping drafts safe until refund save."""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright, expect
from test_refund_layout import SEED, state, open_refund, close_refund

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/refund-account-picker'
ACCOUNTS = '''async()=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
 const tx=db.transaction(['accounts','entries'],'readwrite'),now=Date.now(),stamp={createdAt:now,updatedAt:now};
 const accounts=await new Promise(resolve=>{const r=tx.objectStore('accounts').getAll();r.onsuccess=()=>resolve(r.result)});
 for(const a of accounts)if(a.id!==9001)tx.objectStore('accounts').delete(a.id);
 for(let i=1;i<=16;i++){
  tx.objectStore('accounts').put({...stamp,id:9200+i,name:i===1?'虚构用于退款长名称验证的银行卡账户':'虚构到账账户'+i,
   group:['cash','debit','credit','online'][i%4],balance:10000+i*100,hidden:false,sortOrder:i});
  tx.objectStore('entries').put({...stamp,id:8200+i,type:'expense',amount:100,accountId:9200+i,
   occurredAt:now-i*1000,note:'虚构常用账户记录',deletedAt:0,reimburseStatus:'none'});
 }
 tx.objectStore('accounts').put({...stamp,id:9299,name:'虚构隐藏账户',group:'cash',balance:0,hidden:true});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=reject});db.close();
}'''


def appearance(panel):
    return panel.evaluate('''el=>{
     const s=getComputedStyle(el),name=getComputedStyle(el.querySelector('.picker-item-label')),
      balance=getComputedStyle(el.querySelector('.picker-item-note'));
     return {background:s.backgroundColor,radius:s.borderTopLeftRadius,nameFont:name.fontSize,
      balanceFont:balance.fontSize,columns:getComputedStyle(el.querySelector('.frequent-account-grid')).gridTemplateColumns.split(' ').length};
    }''')


def dismiss(page):
    page.keyboard.press('Escape')
    page.locator('.entry-account-mask').wait_for(state='detached')


def run(browser,width,height,theme,scale,safe):
    context=browser.new_context(viewport={'width':width,'height':height},timezone_id='Asia/Shanghai',
        device_scale_factor=3 if safe else 1,service_workers='block')
    page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED);page.evaluate(ACCOUNTS)
    page.reload();page.locator('#fab').wait_for()
    page.evaluate('''([theme,scale,safe])=>{document.documentElement.dataset.theme=theme;
     document.documentElement.style.setProperty('--seed-type',scale);document.documentElement.style.setProperty('--safe-bottom',safe+'px')}''',[theme,str(scale),safe])
    original=state(page)
    page.locator('#fab').click();page.locator('#acct-btn').click()
    panel=page.locator('.entry-account-picker');expect(panel).to_be_visible()
    expect(panel.locator('.frequent-account')).to_have_count(12)
    standard=appearance(panel)
    dismiss(page);page.locator('#sheet-close').click();page.locator('#sheet.open').wait_for(state='hidden')

    open_refund(page);page.locator('#rf-amount').fill('12.34')
    page.locator('#rf-note').fill('虚构退款账户选择草稿');page.locator('#rf-note').blur()
    date=page.locator('#rf-date').inner_text();page.locator('#rf-account').click()
    expect(panel).to_be_visible(timeout=2000)
    expect(panel.locator('.entry-account-heading h4').first).to_have_text('选择退款到账账户')
    expect(panel.locator('.frequent-account')).to_have_count(12)
    expect(panel.locator('[data-account="9299"]')).to_have_count(0)
    expect(panel.locator('[data-account]')).to_have_count(17)
    expect(panel.locator('[data-account="9001"]')).to_have_attribute('aria-selected','true')
    page.wait_for_timeout(250)
    heights=panel.locator('[data-account]').evaluate_all('(els)=>els.map(el=>el.getBoundingClientRect().height)')
    assert all(height>=44 for height in heights),heights
    assert appearance(panel)==standard,'Refund picker differs from entry picker'
    page.screenshot(path=str(OUT/f'{width}x{height}-{theme}-{scale}.png'),animations='disabled')
    initial_height=panel.bounding_box()['height']
    panel.locator('[data-search]').click();search=panel.locator('input[type="search"]')
    search.fill('不存在的虚构账户');expect(panel.locator('.entry-account-empty')).to_be_visible()
    assert abs(panel.bounding_box()['height']-initial_height)<1
    search.fill('虚构到账账户16');expect(panel.locator('[data-account]')).to_have_count(1)
    page.set_viewport_size({'width':width,'height':520});page.wait_for_timeout(150)
    bounds=panel.bounding_box();assert bounds['y']>=0 and bounds['y']+bounds['height']<=520.5
    assert search.bounding_box()['y']>=0
    page.set_viewport_size({'width':width,'height':height})
    panel.locator('[data-cancel-search]').click();expect(panel.locator('.frequent-account')).to_have_count(12)
    dismiss(page)
    expect(page.locator('#rf-account')).to_contain_text('虚构退款账户')
    expect(page.locator('#rf-amount')).to_have_value('12.34')
    expect(page.locator('#rf-note')).to_have_value('虚构退款账户选择草稿')
    expect(page.locator('#rf-date')).to_have_text(date)
    expect(page.locator('#rf-account')).to_be_focused()
    assert state(page)==original,'Opening/searching/cancelling changed saved data'

    page.locator('#rf-account').click();panel.locator('[data-search]').click()
    panel.locator('input[type="search"]').fill('虚构到账账户16')
    panel.locator('[data-account="9216"]').click();page.locator('.entry-account-mask').wait_for(state='detached')
    expect(page.locator('#rf-account')).to_have_text('虚构到账账户16')
    page.locator('#rf-account').click();expect(panel.locator('[data-account="9216"]')).to_have_attribute('aria-selected','true')
    # Creating and backing out of the form keeps the selected account and refund draft.
    panel.locator('[data-add]').click();panel.locator('[name="name"]').fill('虚构取消新建')
    panel.locator('[data-back]').click();expect(panel.locator('[data-add]')).to_be_focused();dismiss(page)
    assert state(page)==original,'Selecting an existing account saved a refund prematurely'

    if width==390:
        page.locator('#rf-account').click();panel.locator('[data-add]').click()
        panel.locator('[name="name"]').fill('虚构退款新账户')
        panel.locator('.entry-account-type-button').click()
        page.locator('.picker-item[data-value="online"]').click()
        panel.locator('[name="balance"]').fill('10')
        panel.locator('button[type="submit"]').click();page.locator('.entry-account-mask').wait_for(state='detached')
        expect(page.locator('#rf-account')).to_have_text('虚构退款新账户')
        added=state(page);account=next(a for a in added['accounts'] if a['name']=='虚构退款新账户')
        assert account['balance']==1000 and added['entries']==original['entries']
        page.locator('#rf-account').click();expect(panel.locator(f'[data-account="{account["id"]}"]')).to_have_attribute('aria-selected','true')
        dismiss(page);expect(page.locator('#rf-note')).to_have_value('虚构退款账户选择草稿')
        page.locator('#rf-keypad [data-rk="save"]').click();page.locator('#sp-entry-refund').wait_for(state='detached')
        after=state(page);refunds=[e for e in after['entries'] if e.get('refundFlag')]
        assert len(refunds)==1 and refunds[0]['accountId']==account['id'] and refunds[0]['amount']==1234
        assert refunds[0]['refundOfEntryId']==8101 and refunds[0]['note']=='虚构退款账户选择草稿'
        assert next(a for a in after['accounts'] if a['id']==account['id'])['balance']==2234
        assert next(a for a in after['accounts'] if a['id']==9001)['balance']==100000
        assert next(e for e in after['entries'] if e['id']==8101)==next(e for e in original['entries'] if e['id']==8101)
    else:
        close_refund(page);assert state(page)==original
    assert not errors,errors
    context.close();print('PASS shared refund account picker',width,height,theme,scale,safe,flush=True)


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    profiles=[(360,640,'light',1,0),(390,844,'light',1,0),(430,932,'dark',1,0),
        (360,560,'light',1.3,32),(400,810,'dark',1.3,32),(1280,900,'light',1,0)]
    if os.environ.get('GLEAM_REFUND_PICKER_SMOKE')=='1':profiles=profiles[:1]
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for profile in profiles:run(browser,*profile)
        browser.close()
