"""Upgrade a fictional v5 ledger, retaining all financial data and account references."""
from playwright.sync_api import sync_playwright, expect
from test_account_detail_performance import URL, SEED
from test_entry_detail_upgrade import SCHEMA, LEGACY, SNAPSHOT

HISTORY = '''async () => {
 const db=await new Promise(resolve=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>resolve(q.result)});
 const tx=db.transaction('entries','readwrite'), stamp={createdAt:1,updatedAt:1,deletedAt:0,reimburseStatus:'none'};
 const now=Date.now();
 tx.objectStore('entries').put({...stamp,id:20001,type:'transfer',amount:123,fromAccountId:2,toAccountId:1,occurredAt:now+1000});
 tx.objectStore('entries').put({...stamp,id:20002,type:'loan',loanKind:'lend',amount:456,fromAccountId:1,toAccountId:3,occurredAt:now+2000});
 tx.objectStore('entries').put({...stamp,id:20003,type:'expense',amount:999,accountId:2,categoryId:1,
   reimburseStatus:'done',reimburseAccountId:1,reimbursedAmount:234,reimbursedAt:now+3000,occurredAt:now-100000});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}'''

if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width':400,'height':890}, service_workers='block')
        errors = []
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL)
        page.locator('#fab').wait_for()
        schema = page.evaluate(SCHEMA)
        next(store for store in schema['stores'] if store['name'] == 'entries')['indexes'].append({
            'name':'refundOfEntryId','keyPath':'refundOfEntryId','unique':False,'multiEntry':False})
        fixture = URL.rstrip('/')+'/__account_upgrade_fixture'
        page.route(fixture, lambda r: r.fulfill(content_type='text/html', body='<html><title>Isolated v5 fixture</title></html>'))
        page.goto(fixture)
        page.evaluate(LEGACY.replace("open('GleamDB',40)", "open('GleamDB',50)"), schema)
        page.evaluate(SEED, False)
        page.evaluate(HISTORY)
        before = page.evaluate(SNAPSHOT)
        assert before['version'] == 50
        page.goto(URL)
        page.locator('#fab').wait_for()
        after = page.evaluate(SNAPSHOT)
        assert after['version'] == 70 and before['digest'] == after['digest'] and before['counts'] == after['counts'], (before,after)
        page.locator('[data-page="page-acct"]').click()
        page.locator('[data-acct="1"]').click()
        detail = page.locator('#sp-account-detail')
        expect(detail.locator('[data-eid="20001"] .e-amt')).to_have_text('+1.23')
        expect(detail.locator('[data-eid="20002"] .e-amt')).to_have_text('-4.56')
        expect(detail.locator('[data-eid="20003"][data-reimbursement] .e-amt')).to_have_text('+2.34')
        expect(detail.locator('[data-eid="20003"]')).to_have_count(1)
        assert not errors, errors
        browser.close()
        print('PASS v5 -> v7: 20,003 entries preserved; historical transfer, loan and reimbursement indexed', flush=True)
