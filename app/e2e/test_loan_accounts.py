"""真实浏览器验证：借贷对方是账户，不是独立对象。只使用隔离的虚构数据。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from test_acceptance_fixes import SHOTS

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4601/')

def balances(page):
    return page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['accounts','entries','loanContacts']);
      const read=n=>new Promise(r=>{const q=tx.objectStore(n).getAll();q.onsuccess=()=>r(q.result)});
      const [accounts,entries,contacts]=await Promise.all(['accounts','entries','loanContacts'].map(read));db.close();
      return {accounts,entries,contacts};
    }''')

def scenario(page,width):
    page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['accounts','entries','loanContacts'],'readwrite');
      const a=tx.objectStore('accounts');a.clear();tx.objectStore('entries').clear();
      const base={hidden:false,countInNetWorth:true,createdAt:1,updatedAt:1};
      a.put({...base,id:1,name:'演示现金',group:'cash',balance:100000,sortOrder:1});
      a.put({...base,id:2,name:'演示小林',group:'debit',balance:0,sortOrder:2});
      a.put({...base,id:3,name:'演示小林',group:'receivable',balance:0,sortOrder:3});
      tx.objectStore('loanContacts').put({id:77,name:'旧对象不应出现',balance:5200,createdAt:1,updatedAt:1});
      await new Promise(r=>tx.oncomplete=r);db.close();
    }''')
    page.reload();page.wait_for_selector('#fab')
    for kind,amount,expected_fund,expected_loan in [('lend','100',90000,10000),('collect','40',94000,6000),('borrow','80',102000,-2000),('repay','20',100000,0)]:
        page.locator('#fab').click();page.locator('#seg [data-type="loan"]').click()
        page.locator(f'[data-kind="{kind}"]').click()
        page.locator('#loan-who').click();page.locator('.picker-panel.open').wait_for()
        assert page.locator('.picker-item[data-value="3"]').count()==1
        assert page.locator('.picker-item[data-value="2"]').count()==0
        assert '旧对象不应出现' not in page.locator('.picker-panel').inner_text()
        page.locator('.picker-item[data-value="3"]').click();page.locator('.picker-mask').wait_for(state='detached')
        page.locator('#loan-acct').click();page.locator('.picker-panel.open').wait_for()
        assert page.locator('.picker-item[data-value="3"]').count()==0
        page.locator('.picker-item[data-value="1"]').click();page.locator('.picker-mask').wait_for(state='detached')
        for char in amount:page.locator(f'#keypad [data-k="{char}"]').click()
        if kind=='lend':page.screenshot(path=str(SHOTS/f'loan-account-entry-{width}.png'))
        page.locator('#keypad [data-k="save"]').click();page.locator('#sheet.open').wait_for(state='detached')
        data=balances(page);by_id={a['id']:a['balance'] for a in data['accounts']}
        assert by_id[1]==expected_fund and by_id[3]==expected_loan and by_id[2]==0
        assert sum(by_id.values())==100000
        entry=data['entries'][-1]
        assert entry['type']=='loan' and entry['loanKind']==kind
        assert not entry.get('loanContactId') and not entry.get('accountId')
        assert {entry['fromAccountId'],entry['toAccountId']}=={1,3}
        assert len(data['contacts'])==1 and data['contacts'][0]['balance']==5200
    page.locator('.tab[data-page="page-acct"]').click();page.locator('[data-acct="3"]').click()
    page.locator('#account-months').wait_for();page.wait_for_timeout(300)
    assert page.locator('.account-month-entries [data-eid]').count()==4
    page.screenshot(path=str(SHOTS/f'loan-account-detail-{width}.png'))
    page.locator('#account-detail-entry').click();page.locator('#loan-block:visible').wait_for()
    assert page.locator('#loan-who b').inner_text()=='演示小林'
    page.locator('#sheet-close').click()
    page.locator('#sp-account-detail [data-act="back"]').click();page.locator('#sp-account-detail').wait_for(state='detached')
    page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction('accounts','readwrite'),store=tx.objectStore('accounts');
      for(const id of [1,3]) { const q=store.get(id);q.onsuccess=()=>store.put({...q.result,hidden:true}); }
      await new Promise(r=>tx.oncomplete=r);db.close();
    }''')
    page.locator('.tab[data-page="page-mine"]').click();page.locator('[data-sub="sp-loan"]').click()
    page.locator('[data-loan-account="3"]').wait_for()
    assert page.locator('[data-loan-account="2"]').count()==0
    assert '旧对象不应出现' not in page.locator('#sp-loan').inner_text()
    page.locator('[data-loan-account="3"]').click();page.locator('#account-detail-entry').click()
    page.locator('#loan-block:visible').wait_for()
    assert page.locator('#loan-who b').inner_text()=='演示小林', '显式从隐藏应收应付账户进入仍需预设该账户'
    page.locator('#sheet-close').click()
    page.locator('#sp-account-detail [data-act="back"]').click();page.locator('#sp-account-detail').wait_for(state='detached')
    page.locator('#sp-loan [data-act="back"]').click();page.locator('#sp-loan').wait_for(state='detached')
    page.locator('#tab-home').click()
    page.locator('#page-home [data-entry="1"]').click();page.locator('#sp-entry-view.open').wait_for()
    assert '演示现金 → 演示小林' in page.locator('#sp-entry-view').inner_text()
    page.locator('[data-view-action="edit"]').click();page.locator('#sheet.open').wait_for()
    assert page.locator('#loan-who b').inner_text()=='演示小林' and page.locator('#loan-acct b').inner_text()=='演示现金'
    page.locator('#sheet-close').click()
    page.locator('[data-view-action="copy"]').click();page.locator('#sheet.open').wait_for()
    assert page.locator('#loan-who b').inner_text()=='演示小林'
    assert page.locator('#amt').inner_text() in ('100','100.00'), '复制借贷也应带入原金额'
    copied=balances(page)
    assert len(copied['entries'])==4, '打开复制草稿不能写入新账单'
    assert {a['id']:a['balance'] for a in copied['accounts']}=={1:100000,2:0,3:0}

def ambiguous_import(page,width):
    account_id=page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction('accounts','readwrite'),store=tx.objectStore('accounts');
      const original=await new Promise(r=>{const q=store.getAll();q.onsuccess=()=>r(q.result.find(a=>a.name==='现金'))});
      store.put({...original,id:987,group:'receivable',balance:0});await new Promise(r=>tx.oncomplete=r);db.close();return original.id;
    }''')
    page.locator('.tab[data-page="page-mine"]').click();page.locator('[data-sub="sp-backup"]').click()
    with page.expect_file_chooser() as chooser:page.locator('#sp-backup [data-act="pick-import"]').click()
    chooser.value.set_files(str(Path(__file__).parent/'fixtures/wacai-demo.xlsx'))
    page.locator('#sp-import [data-act="to-map"]').click()
    run=page.locator('#sp-import [data-act="run"]');run.wait_for()
    assert run.is_disabled(), '同名歧义未处理前应禁止导入'
    while page.get_by_role('button',name='请选择同名账户',exact=True).count():
        page.get_by_role('button',name='请选择同名账户',exact=True).first.click()
        assert '应收/应付' in page.locator('.picker-item[data-value="987"] .picker-item-note').inner_text(), '同名候选必须显示账户分组'
        page.locator(f'.picker-item[data-value="{account_id}"]').click();page.locator('.picker-mask').wait_for(state='detached')
    assert not run.is_disabled(), '账户歧义已确认后应立即允许开始导入'
    run.click();page.locator('#sp-import .imp-report').wait_for()
    assert '8 条成功入账' in page.locator('.imp-report').inner_text().replace('\n',' ')
    data=balances(page)
    assert all(e.get('fromAccountId') and e.get('toAccountId') and not e.get('loanContactId') for e in data['entries'] if e['type']=='loan')

if __name__=='__main__':
    failures=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        cases=[(scenario,w) for w in (360,390,430,1024)]+[(ambiguous_import,390)]
        if os.environ.get('GLEAM_E2E_CASE')=='import':cases=[(ambiguous_import,390)]
        for fn,width in cases:
            context=browser.new_context(viewport={'width':width,'height':844},service_workers='block')
            page=context.new_page();page.set_default_timeout(7000)
            try:
                page.goto(URL);page.wait_for_load_state('networkidle');page.wait_for_selector('#fab');fn(page,width)
                print('PASS loan accounts',fn.__name__,width,flush=True)
            except Exception as e:
                print('FAIL loan accounts',width,str(e),flush=True);failures.append(width)
                page.screenshot(path=str(SHOTS/f'loan-accounts-{width}-fail.png'))
            finally:context.close()
        browser.close()
    raise SystemExit(1 if failures else 0)
