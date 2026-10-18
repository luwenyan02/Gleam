"""Atomic category merge and aligned single-line category labels with fictional data."""
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4602/')
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/category-merge'
SEED='''async()=>{
 const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
 const tx=db.transaction(['categories','entries','accounts','entryTags','quickTemplates','recurringRules','settings'],'readwrite');
 for(const n of ['categories','entries','accounts','entryTags','quickTemplates','recurringRules'])tx.objectStore(n).clear();
 const stamp={createdAt:1,updatedAt:1};
 const categories=[{id:1,name:'人情',kind:'expense',icon:'ic-tag'},{id:2,name:'人情支出',kind:'expense',icon:'ic-tag'},{id:3,name:'礼金红包',kind:'expense',parentId:1,icon:'ic-tag'},{id:4,name:'礼金红包',kind:'expense',parentId:2,icon:'ic-tag'},{id:5,name:'工资',kind:'income',icon:'ic-coin'},{id:6,name:'医教',kind:'expense',icon:'ic-tag'},{id:7,name:'非常长的虚构日常消费分类',kind:'expense',parentId:6,icon:'ic-tag'},{id:8,name:'交通',kind:'expense',icon:'ic-tag'},{id:9,name:'地铁',kind:'expense',parentId:8,icon:'ic-tag'}];
 categories.forEach(c=>tx.objectStore('categories').put({...stamp,sortOrder:c.id,...c}));
 tx.objectStore('accounts').put({...stamp,id:1,name:'虚构钱包',group:'cash',balance:123456,hidden:false,countInNetWorth:true,sortOrder:1});
 for(let id=1;id<=3;id++)tx.objectStore('entries').put({...stamp,id,type:'expense',categoryId:id===3?9:3,accountId:1,amount:1000,occurredAt:Date.now()-id*1000,deletedAt:id===2?Date.now()-10000:0,reimburseStatus:'none'});
 tx.objectStore('quickTemplates').put({...stamp,id:1,name:'虚构模板',amount:100,categoryId:3,sortOrder:1});
 tx.objectStore('recurringRules').put({...stamp,id:1,name:'虚构周期账',type:'expense',amount:100,categoryId:3,accountId:1,amountConfirm:false,freq:'monthly',days:[1],enabled:false,nextRunAt:Date.now()+86400000});
 tx.objectStore('settings').put({key:'app.seeded',value:true});
 await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=()=>j(tx.error)});db.close();
}'''
READ='''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const n=['categories','entries','accounts','quickTemplates','recurringRules'];const tx=db.transaction(n,'readonly');const rows=await Promise.all(n.map(k=>new Promise(r=>{const q=tx.objectStore(k).getAll();q.onsuccess=()=>r(q.result)})));db.close();return Object.fromEntries(n.map((k,i)=>[k,rows[i]]))}'''
def run(page,width,device=False):
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc==urlsplit(URL).netloc else r.abort())
 page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED);page.reload();page.locator('#fab').wait_for()
 if device:page.add_style_tag(content=':root{--safe-top:24px;--safe-bottom:24px}')
 page.locator('#fab').click();page.locator('#note').fill('虚构草稿');page.locator('#note').blur();page.locator('[data-k="8"]').click();page.locator('[data-cat-more]').click()
 expect(page.locator('#keypad')).to_be_hidden();expect(page.locator('#cat-jump')).to_be_visible();expect(page.locator('#cat-jump input')).to_have_count(0)
 page.locator('[data-cat-jump="6"]').click();expect(page.locator('[data-cat-jump="6"]')).to_have_attribute('aria-pressed','true')
 button=page.locator('#cat-grid [data-id="7"]');button.wait_for();button.scroll_into_view_if_needed()
 metrics=button.locator('span').last.evaluate('(e)=>({whiteSpace:getComputedStyle(e).whiteSpace,overflow:getComputedStyle(e).textOverflow,font:parseFloat(getComputedStyle(e).fontSize),h:e.getBoundingClientRect().height,line:parseFloat(getComputedStyle(e).lineHeight)})')
 assert metrics['whiteSpace']=='nowrap' and metrics['overflow']=='ellipsis' and metrics['font']>=13
 expect(button).to_have_attribute('title','医教／非常长的虚构日常消费分类')
 assert page.locator('[data-cat-section="6"]').evaluate('e=>parseFloat(getComputedStyle(e).fontSize)>=14')
 page.screenshot(path=str(OUT/f'categories-{width}.png'),animations='disabled');button.click()
 expect(page.locator('#keypad')).to_be_visible();expect(page.locator('#pick-name')).to_have_text('非常长的虚构日常消费分类');expect(page.locator('#amt')).to_have_text('8');expect(page.locator('#note')).to_have_value('虚构草稿');page.locator('#sheet-close').click()
 before=page.evaluate(READ)
 page.locator('[data-page="page-mine"]').click();page.locator('[data-sub="sp-categories"]').click();page.locator('#cm-merge').click();page.locator('[data-merge-category="3"]').click();page.locator('[data-merge-category="4"]').click()
 sheet=page.locator('#sheet[aria-label="确认合并分类"]');expect(sheet).to_contain_text('人情／礼金红包');expect(sheet).to_contain_text('人情支出／礼金红包');expect(sheet).to_contain_text('1 笔有效账单、1 笔回收站账单');page.screenshot(path=str(OUT/f'merge-preview-{width}.png'),animations='disabled')
 page.locator('[data-merge-close]').click();assert page.evaluate(READ)==before
 page.locator('#cm-merge').click();page.locator('[data-merge-category="3"]').click();page.locator('[data-merge-category="4"]').click();page.locator('[data-merge-confirm]').click();page.locator('#sheet.open').wait_for(state='detached')
 after=page.evaluate(READ);assert all(c['id']!=3 for c in after['categories']);assert next(c for c in after['categories'] if c['id']==4)['parentId']==2
 assert after['accounts']==before['accounts'];assert len(after['entries'])==len(before['entries'])
 for old,row in zip(before['entries'],after['entries']):
  assert row['categoryId']==(4 if old['categoryId']==3 else old['categoryId'])
  assert {k:v for k,v in old.items() if k not in ('categoryId','updatedAt')}=={k:v for k,v in row.items() if k not in ('categoryId','updatedAt')}
 assert after['quickTemplates'][0]['categoryId']==4 and after['recurringRules'][0]['categoryId']==4
 expect(page.locator('#cm-list [data-id="3"]')).to_have_count(0);expect(page.locator('#cm-list [data-id="4"]')).to_have_count(1)
 page.locator('#sp-categories .sub-head [data-act="back"]').click();page.locator('[data-sub="sp-backup"]').click();expect(page.locator('#sp-backup')).to_contain_text('合并分类「人情／礼金红包」前')
 # The existing restore snapshot is a concrete recovery path, including templates and rules.
 page.locator('#sp-backup [data-undo]').first.click();page.locator('#dialog-scrim [data-act="ok"]').click();page.locator('#toast.show').wait_for(state='hidden')
 page.wait_for_function("async()=>{const d=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const t=d.transaction('categories');const found=await new Promise(r=>{const q=t.objectStore('categories').get(3);q.onsuccess=()=>r(!!q.result)});d.close();return found}")
 assert page.evaluate(READ)==before
 # Saving a name-only edit must preserve imported icon metadata. Explicitly
 # selecting a generic icon must persist that choice across display surfaces.
 page.locator('#sp-backup .sub-head [data-act="back"]').click();page.locator('[data-sub="sp-categories"]').click()
 page.locator('#cm-list [data-id="9"]').click();expect(page.locator('#cf-icons [data-icon="ic-metro"]')).to_have_class('icon-cell active')
 page.locator('#sheet [data-act="save"]').click();page.locator('#sheet.open').wait_for(state='detached')
 cat=next(c for c in page.evaluate(READ)['categories'] if c['id']==9);assert cat['icon']=='ic-tag' and not cat.get('iconOverride')
 page.locator('#cm-list [data-id="9"]').click();page.locator('#cf-icons [data-icon="ic-tag"]').click();page.locator('#sheet [data-act="save"]').click();page.locator('#sheet.open').wait_for(state='detached')
 cat=next(c for c in page.evaluate(READ)['categories'] if c['id']==9);assert cat['icon']=='ic-tag' and cat['iconOverride'] is True
 expect(page.locator('#cm-list [data-id="9"] .e-ic use')).to_have_attribute('href','#ic-tag')
 page.locator('#sp-categories .sub-head [data-act="back"]').click();page.locator('#tab-home').click();page.locator('#fab').click();expect(page.locator('#cat-grid [data-id="9"] use')).to_have_attribute('href','#ic-tag')
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');assert not errors,errors
 print('PASS category navigation, merge and snapshot undo',width,'Xiaomi14' if device else '',flush=True)
if __name__=='__main__':
 OUT.mkdir(parents=True,exist_ok=True)
 with sync_playwright() as p:
  b=p.chromium.launch()
  for width in (360,390,400,430,1280):
   c=b.new_context(viewport={'width':width,'height':890 if width==400 else 844},device_scale_factor=3 if width==400 else 1,service_workers='block',reduced_motion='reduce',locale='zh-CN',timezone_id='Asia/Shanghai')
   run(c.new_page(),width,width==400);c.close()
  b.close()
