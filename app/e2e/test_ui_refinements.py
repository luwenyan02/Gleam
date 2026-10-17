"""四宽度明细、账户、备份与详情排版，含深色和长内容。"""
import os,sys
from pathlib import Path
sys.path.insert(0,str(Path('e2e').resolve()))
from playwright.sync_api import sync_playwright
from test_acceptance_fixes import seed
from test_m3 import open_backup
out=Path(__file__).resolve().parents[2]/'.tmp/tests/e2e/ui-v1.11.6';out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as pw:
 b=pw.chromium.launch()
 for width in (360,390,430,1280):
  for theme in ('light','dark'):
   ctx=b.new_context(viewport={'width':width,'height':950},service_workers='block');p=ctx.new_page()
   p.goto(os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4601/'));p.locator('#fab').wait_for();seed(p,count=2,amount=194436)
   p.evaluate("""async()=>{
    const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
    const tx=db.transaction(['accounts','entries'],'readwrite');
    ['cash','credit','debit','online','investment','receivable'].forEach((group,i)=>tx.objectStore('accounts').put({id:i+1,name:'虚构账户名称很长用于验证换行及大金额',group,balance:192779520,hidden:false,countInNetWorth:true,sortOrder:i,createdAt:1,updatedAt:1}));
    const q=tx.objectStore('entries').get(1);q.onsuccess=()=>tx.objectStore('entries').put({...q.result,note:'虚构购物备注很长用于验证明细省略与详情完整显示'});
    await new Promise(r=>tx.oncomplete=r);db.close();
   }""")
   p.reload();p.locator('#fab').wait_for()
   p.evaluate("t=>document.documentElement.setAttribute('data-theme',t)",theme)
   p.wait_for_timeout(400)
   assert '月' not in p.locator('#hm-days .e-meta').first.inner_text()
   for name,sel in [('home','#page-home'),('detail','#sp-entry-view'),('account','#page-acct'),('backup','#sp-backup')]:
    if name=='detail':p.locator('#hm-days [data-entry="1"]').click()
    if name=='account':
     p.locator('#sp-entry-view [data-act="back"]').click();p.locator('#sp-entry-view').wait_for(state='detached');p.locator('.tab[data-page="page-acct"]').click()
    if name=='account':
     p.locator('.group-head').first.wait_for()
     for group in p.locator('.group-head[aria-expanded="true"]').evaluate_all('els=>els.map(e=>e.dataset.group)'):p.locator(f'[data-group="{group}"]').click()
    if name=='backup':open_backup(p)
    p.wait_for_timeout(400)
    assert p.locator(sel).evaluate('e=>e.scrollWidth<=e.clientWidth+1'),(width,theme,name)
    if name=='account':
     assert p.locator('.group-head[aria-expanded="true"]').count()==0
     assert p.locator('.group-head').evaluate_all('els=>els.every(e=>e.scrollWidth<=e.clientWidth+1)')
    if name=='backup':assert p.locator('.backup-status').bounding_box()['height']<260
    p.locator(sel).screenshot(path=str(out/f'{name}-{width}-{theme}.png'))
   ctx.close();print('PASS',width,theme,flush=True)
 b.close()
