# -*- coding: utf-8 -*-
"""Official Wacai layout, replacement, rollback and reconciliation; fictional data only."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from test_import_safety import open_backup
from test_stats_safety import seed

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
SHOTS = Path(os.environ.get('GLEAM_E2E_SCREENSHOTS', '../.tmp/tests/wacai-import'))
HEADERS = ['日期时间', '类型', '类别', '金额', '币种', '收付款人', '收付账户', '参与人', '标签', '商家', '属性', '备注']
LONG = '虚构很长的资金账户名称用于验证窄屏布局'
def row(amount, kind='支出', attr=''):
    return ['2026-10-15 18:28:38', kind, '虚构餐饮/虚构晚餐', str(amount), '人民币', '', LONG, '自己', '', '', attr, '虚构备注']
ROWS = [row(100), row(-20, attr='退款'), row(50, '收入'), row(-5, '收入', '退款'), row(0, '收入'), row(10), row(10),
        ['2026-10-15 18:30:01','转账','转账','15','人民币','',f'{LONG}:-15.00, 虚构银行卡:+15.00','','','','',''],
        ['2026-10-15 18:30:02','借贷','借出','8','人民币','自己:-8.00, 虚构朋友:+8.00',LONG,'','','','','']]

def choose(page, rows=ROWS):
    grid = [['挖财记账导出明细'], ['操作人：虚构'], ['导出账本：虚构'], ['账单时间：虚构'], [f'总笔数：{len(rows)}笔'], ['挖财记账账单明细列表'], HEADERS, *rows]
    content = '\ufeff'+'\n'.join('\t'.join(r) for r in grid)
    with page.expect_file_chooser() as chooser:
        page.locator('#sp-backup [data-act="pick-import"]').click()
    chooser.value.set_files({'name':'虚构官方导出.xls','mimeType':'application/vnd.ms-excel','buffer':content.encode()})
    page.locator('#sp-import [data-act="replace-mode"]').wait_for()

def data(page):
    return page.evaluate('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const names=[...db.objectStoreNames];const tx=db.transaction(names,'readonly');const rows=await Promise.all(names.map(n=>new Promise(r=>{const q=tx.objectStore(n).getAll();q.onsuccess=()=>r(q.result)})));db.close();return Object.fromEntries(names.map((n,i)=>[n,rows[i]]));}''')

def mode(page, replace):
    action = 'replace-mode' if replace else 'append-mode'
    page.locator(f'#sp-import [data-act="{action}"]').click()
    page.wait_for_function('(action)=>document.querySelector(`[data-act="${action}"]`).getAttribute("aria-pressed")==="true"',arg=action)

def shot(page, name):
    page.wait_for_timeout(350)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'page overflow'
    page.screenshot(path=str(SHOTS / f'{name}.png'))

def run(page, width):
    page.goto(URL);page.locator('#fab').wait_for()
    page.evaluate('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const tx=db.transaction(['lifeNotes','settings','budgets'],'readwrite');
      tx.objectStore('lifeNotes').put({id:901,kind:'diary',title:'保留生活记录',body:'虚构生活正文',occurredAt:1,deletedAt:0,createdAt:1,updatedAt:1});
      tx.objectStore('settings').put({key:'ai.apiKey',value:'fictional-key-preserved',updatedAt:1});
      tx.objectStore('budgets').put({id:901,month:'2026-10',amount:999,createdAt:1,updatedAt:1});
      await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error)});db.close();}''')
    before=data(page);open_backup(page);choose(page)
    shot(page,f'{width}-append');mode(page,True);shot(page,f'{width}-replace')
    mode(page,False);mode(page,True)
    page.locator('#sp-import [data-act="to-map"]').click();shot(page,f'{width}-mapping')
    # New-account group choices preserve fund/loan roles; all choices can be selected.
    fund = page.locator('#sp-import [data-acct]').filter(has_text='自动新建').first
    for group in ['cash','credit','debit','online','investment','stored','other']:
        fund.click()
        assert page.locator('.picker-mask [data-value="auto:receivable"]').count() == 0
        page.locator(f'.picker-mask [data-value="auto:{group}"]').click()
        page.locator('.picker-mask').wait_for(state='detached')
    fund.click();page.locator('.picker-mask [data-value="auto:cash"]').click()
    page.locator('.picker-mask').wait_for(state='detached')
    loan = page.locator('#sp-import [data-acct="loan:虚构朋友"]')
    loan.click()
    assert page.locator('.picker-mask .picker-item').count() == 1
    assert page.locator('.picker-mask [data-value="auto:receivable"]').count() == 1
    page.locator('.picker-mask [data-value="auto:receivable"]').click()
    page.locator('.picker-mask').wait_for(state='detached')
    # General accounts offer all eight groups, including receivables.
    general = page.locator('#sp-import [data-acct="general:虚构银行卡"]')
    general.click()
    assert page.locator('.picker-mask .picker-item').count() == 8
    shot(page,f'{width}-account-types')
    page.locator('.picker-mask [data-value="auto:debit"]').click()
    page.locator('.picker-mask').wait_for(state='detached')
    page.locator('#sp-import [data-act="run"]').click()
    page.locator('#dialog-scrim [data-act="cancel"]').click()
    assert data(page)==before, 'cancel changed data'
    if width == 390:
        page.evaluate('''()=>{const add=IDBObjectStore.prototype.add;let fail=true;IDBObjectStore.prototype.add=function(v,...args){if(fail&&this.name==='entries'){fail=false;throw new DOMException('虚构写入失败','AbortError')}return add.call(this,v,...args)}}''')
        page.locator('#sp-import [data-act="run"]').click();page.locator('#dialog-scrim [data-act="ok"]').click()
        page.get_by_text('导入失败，已全部回滚：虚构写入失败',exact=False).wait_for()
        assert data(page)==before, 'failed replacement did not roll back'
    page.locator('#sp-import [data-act="run"]').click();page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('#sp-import .imp-report').wait_for(timeout=30000);shot(page,f'{width}-report')
    after=data(page)
    assert len(after['entries'])==9, 'duplicate rows or zero record lost'
    assert next(a for a in after['accounts'] if a['name']==LONG)['group']=='cash'
    assert after['lifeNotes']==before['lifeNotes']
    assert next(s['value'] for s in after['settings'] if s['key']=='ai.apiKey')=='fictional-key-preserved'
    assert not after['budgets'] and not after['quickTemplates'] and not after['recurringRules']
    assert sum(e['amount'] for e in after['entries'] if e['type']=='expense')==10000
    assert sum(e['amount'] for e in after['entries'] if e['type']=='income')==4500
    assert sum(a['balance'] for a in after['accounts'])==-5500
    assert all(e['occurredAt']%60000 in (38000,1000,2000) for e in after['entries'])
    with page.expect_download() as download: page.locator('#sp-import [data-act="export-report"]').click()
    assert download.value.suggested_filename=='挖财导入核对.xlsx'
    page.locator('#sp-import [data-act="done"]').click();page.wait_for_timeout(400)
    # Repeating replacement must not accumulate records; selecting invalid replacement is blocked before deleting.
    choose(page, [row(1), row('not-a-number')]);mode(page,True)
    assert page.locator('#sp-import [data-act="to-map"]').is_disabled()
    assert data(page)==after
    page.locator('#sp-import [data-act="cancel"]').click();page.wait_for_timeout(400);choose(page);mode(page,True)
    page.locator('#sp-import [data-act="to-map"]').click();page.locator('#sp-import [data-act="run"]').click();page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('#sp-import .imp-report').wait_for(timeout=30000)
    assert len(data(page)['entries'])==9

def negative_income_calendar(page):
    page.goto(URL);page.locator('#fab').wait_for()
    today = page.evaluate('new Date().setHours(12,0,0,0)')
    seed(page, [{'id':1,'type':'income','amount':-500,'occurredAt':today,'accountId':1,'categoryId':1,
                 'sourceAdjustment':{'source':'wacai','rowNo':8}}])
    page.locator('#hm-quick .hm-all').click();page.get_by_text('日历',exact=True).last.click()
    page.locator('#sp-calendar .cd-sum').wait_for()
    assert '收入' in page.locator('#sp-calendar .cd-sum').inner_text(), 'income reversal hidden in daily summary'
    assert '-¥5.00' in page.locator('#sp-calendar .cd-sum').inner_text()
    assert '-5.00' in page.locator('#sp-calendar [data-eid="1"]').inner_text()
    shot(page, f'{page.viewport_size["width"]}-income-reversal')

if __name__=='__main__':
    SHOTS.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
        for width in [360,390,430,1280]:
            context=browser.new_context(viewport={'width':width,'height':900},timezone_id='Asia/Shanghai',accept_downloads=True)
            page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            run(page,width)
            negative_income_calendar(page)
            assert not errors, errors
            context.close();print(f'PASS wacai_replace width={width}',flush=True)
        browser.close()
