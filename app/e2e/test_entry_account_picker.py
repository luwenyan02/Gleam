"""Entry account picker: synthetic last-year usage, stable search and draft-safe creation."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4602/')
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/entry-account-picker'
SEED='''async () => {
 const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
 const tx=db.transaction(['accounts','entries','categories'],'readwrite');const now=Date.now();
 tx.objectStore('accounts').clear();tx.objectStore('entries').clear();
 for(let id=1;id<=16;id++) {
  tx.objectStore('accounts').put({id,name:id===1?'虚构用于长名称验证的银行卡账户':`虚构账户${id}`,group:id%2?'cash':'credit',balance:id*100,hidden:false,sortOrder:id,createdAt:now,updatedAt:now});
  tx.objectStore('entries').put({id,type:id<=13?'expense':'income',amount:100,accountId:id,occurredAt:now-id*1000,deletedAt:0,reimburseStatus:'none',createdAt:now,updatedAt:now});
 }
 for(let i=0;i<23;i++)tx.objectStore('categories').put({id:900+i,name:`虚构分类${i}`,kind:'income',icon:'ic-coin',sortOrder:i,createdAt:now,updatedAt:now});
 await new Promise(resolve=>tx.oncomplete=resolve);db.close();
}'''
def run(page,width):
 page.goto(URL);page.wait_for_selector('#fab');page.evaluate(SEED);page.reload();page.wait_for_selector('#fab');page.locator('#fab').click()
 page.locator('#seg [data-type="income"]').click()
 expect(page.locator('#cat-grid .cat')).to_have_count(20)
 assert page.locator('#cat-grid').evaluate('e=>getComputedStyle(e).gridTemplateColumns.split(" ").length')==5
 expect(page.locator('#date-txt')).to_have_text(__import__('re').compile(r'今天 \d{2}:\d{2}'))
 assert page.locator('#date-chip svg,#acct-btn svg').count()==0
 page.locator('#seg [data-type="expense"]').click()
 page.locator('#note').fill('虚构未保存草稿');page.locator('#note').blur()
 page.locator('#keypad [data-k="8"]').click()
 page.screenshot(path=str(OUT/f'entry-{width}.png'),animations='disabled')
 page.locator('#acct-btn').click();panel=page.locator('.entry-account-picker');panel.wait_for();page.wait_for_timeout(250)
 expect(panel.locator('.frequent-account')).to_have_count(12)
 assert panel.locator('.frequent-account').first.get_attribute('data-account')=='1'
 expect(panel.locator('input[type="search"]')).not_to_be_visible()
 assert len(panel.locator('[data-account]').all())==16
 page.screenshot(path=str(OUT/f'accounts-{width}.png'),animations='disabled')
 height=panel.bounding_box()['height']
 panel.locator('[data-search]').click();panel.locator('input[type="search"]').fill('虚构账户16')
 expect(panel.locator('[data-account]')).to_have_count(1)
 assert abs(panel.bounding_box()['height']-height)<1
 panel.locator('input[type="search"]').fill('不存在的账户')
 expect(panel.locator('[data-account]')).to_have_count(0)
 expect(panel.locator('.entry-account-empty')).to_be_visible()
 assert abs(panel.bounding_box()['height']-height)<1
 page.screenshot(path=str(OUT/f'empty-{width}.png'),animations='disabled')
 panel.locator('[data-cancel-search]').click();expect(panel.locator('.frequent-account')).to_have_count(12)
 panel.locator('[data-account="2"]').click();page.locator('.entry-account-mask').wait_for(state='detached')
 expect(page.locator('#acct-name')).to_have_text('虚构账户2')
 expect(page.locator('#note')).to_have_value('虚构未保存草稿')
 page.locator('#seg [data-type="income"]').click();page.locator('#acct-btn').click()
 expect(panel.locator('.frequent-account')).to_have_count(3)
 panel.locator('[data-add]').click();panel.locator('[name="name"]').fill('虚构新增账户');panel.locator('.entry-account-type-button').click();page.locator('.picker-mask .picker-item[data-value="online"]').click();page.locator('.entry-account-type-button').wait_for(state='visible');page.wait_for_timeout(250)
 panel.locator('[name="balance"]').fill('-12.34');panel.locator('button[type="submit"]').click();page.locator('.entry-account-mask').wait_for(state='detached')
 expect(page.locator('#acct-name')).to_have_text('虚构新增账户');expect(page.locator('#note')).to_have_value('虚构未保存草稿')
 page.locator('#acct-btn').click();panel.wait_for();page.wait_for_timeout(250);page.evaluate("document.documentElement.dataset.theme='dark'")
 page.screenshot(path=str(OUT/f'dark-{width}.png'),animations='disabled')
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
 print('PASS entry account picker',width)
if __name__=='__main__':
 OUT.mkdir(parents=True,exist_ok=True)
 with sync_playwright() as p:
  browser=p.chromium.launch()
  for width in (360,390,430,1280):
   page=browser.new_page(viewport={'width':width,'height':900});run(page,width);page.close()
  browser.close()
