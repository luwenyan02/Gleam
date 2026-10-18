"""Copy preserves source values; explicit clear/today actions change only the new draft."""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/entry-copy-edit'
SEED = '''async theme => {
  const db = await new Promise(resolve => { const r=indexedDB.open('GleamDB'); r.onsuccess=()=>resolve(r.result); });
  const tx=db.transaction(['entries','accounts','categories','settings'],'readwrite');
  tx.objectStore('settings').put({key:'theme.mode',value:theme,updatedAt:1});
  const categories=await new Promise(resolve=>{ const r=tx.objectStore('categories').getAll(); r.onsuccess=()=>resolve(r.result); });
  const stamp={createdAt:1,updatedAt:1}, date=new Date(); date.setDate(date.getDate()-3); date.setHours(9,17,0,0);
  for (const [id,group] of [[9001,'cash'],[9002,'debit'],[9003,'receivable']])
    tx.objectStore('accounts').put({...stamp,id,group,name:'虚构复制账户'+id,balance:100000,hidden:false,countInNetWorth:true,sortOrder:id});
  tx.objectStore('entries').clear();
  for (const [index,type] of ['expense','income','transfer','loan'].entries()) {
    const row={...stamp,id:8101+index,type,amount:3680,occurredAt:date.getTime(),note:'虚构复制备注 <>&',deletedAt:0,reimburseStatus:'none'};
    if(type==='expense'||type==='income') { row.accountId=9001; row.categoryId=categories.find(c=>c.kind===type&&(type==='income'||c.parentId!=null)).id; }
    else { row.fromAccountId=9001; row.toAccountId=type==='loan'?9003:9002; if(type==='loan')row.loanKind='lend'; }
    tx.objectStore('entries').put(row);
  }
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
  return date.getTime();
}'''

def rows(page):
    return page.evaluate('''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const rows=await new Promise(resolve=>{const r=db.transaction('entries').objectStore('entries').getAll();r.onsuccess=()=>resolve(r.result)});db.close();return rows;
    }''')

def open_copy(page, source):
    page.locator(f'#hm-days [data-entry="{source}"]').click()
    page.locator('#sp-entry-view [data-view-action="copy"]').click()
    page.locator('#sheet.open #keypad').wait_for()
    page.wait_for_timeout(300)
    expect(page.locator('#amt')).to_have_text('36.8')
    expect(page.locator('#note')).to_have_value('虚构复制备注 <>&')
    expect(page.locator('#date-today')).to_be_visible()
    expect(page.locator('#date-today')).to_have_text('改为今天')
    assert page.locator('.entry-date-actions').evaluate('''el=>{
      const style=getComputedStyle(el), date=getComputedStyle(el.querySelector('#date-chip')),
        today=getComputedStyle(el.querySelector('#date-today'));
      return parseFloat(style.borderTopWidth)>0 && parseFloat(date.borderTopWidth)===0 && parseFloat(today.borderTopWidth)===0;
    }''')

def close_detail(page):
    page.locator('#sp-entry-view .sub-head [data-act="back"]').click()
    page.locator('#sp-entry-view').wait_for(state='detached')

def run(browser, width, theme, scale):
    context=browser.new_context(viewport={'width':width,'height':844},device_scale_factor=3 if scale>1 else 1,
        timezone_id='Asia/Shanghai',service_workers='block')
    page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(URL);page.locator('#fab').wait_for();original_date=page.evaluate(SEED,theme)
    originals=rows(page);page.reload();page.locator('#hm-days [data-entry="8101"]').wait_for()
    page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",scale)}',[theme,str(scale)])
    sources=[8101,8102,8103,8104] if width==390 and scale==1 else [8101]
    for source in sources:
        open_copy(page,source)
        # The date side opens the picker; cancel keeps the copied timestamp.
        page.locator('#date-chip').click()
        page.locator('.dw-panel').wait_for()
        page.locator('.dw-mask').click(position={'x':5,'y':5})
        page.locator('.dw-panel').wait_for(state='detached')
        expect(page.locator('#date-today')).to_be_visible()
        page.locator('#note').scroll_into_view_if_needed();page.locator('#note').click()
        expect(page.locator('#note')).to_be_focused()
        expect(page.locator('#note')).to_have_value('虚构复制备注 <>&')
        page.locator('#note').blur()
        expect(page.locator('#keypad')).to_be_visible()
        assert page.locator('#sheet').evaluate('el=>el.scrollWidth<=el.clientWidth+1')
        if source in (8101,8102):
            # Large-font layouts use the existing form scroll area to reach the metadata row.
            page.locator('#acct-btn').scroll_into_view_if_needed()
            geometry=page.evaluate('''()=>{const box=s=>document.querySelector(s).getBoundingClientRect().toJSON();
              return {date:box('#date-chip'),field:box('.entry-date-actions'),today:box('#date-today'),account:box('#acct-btn'),keyboard:box('#entry-keyboard')};}''')
            assert abs(geometry['field']['top']-geometry['account']['top'])<1,geometry
            assert geometry['today']['width']>=44 and geometry['today']['height']>=44,geometry
            assert geometry['account']['bottom']<=geometry['keyboard']['top'],geometry
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT/f'copy-{width}-{theme}-{scale}-{source}.png'),animations='disabled')
        page.locator('#keypad [data-k="save"]').click()
        page.locator('#sheet.open').wait_for(state='detached')
        copied=max(rows(page),key=lambda row:row['id'])
        assert copied['amount']==3680 and copied['note']=='虚构复制备注 <>&' and copied['occurredAt']==original_date,copied
        assert [r for r in rows(page) if r['id'] in range(8101,8105)]==originals
        close_detail(page)

    # Clear the entire calculation, including its pending left operand, without changing the note/date.
    open_copy(page,8101)
    page.locator('#note').scroll_into_view_if_needed();page.locator('#note-clear').click()
    expect(page.locator('#note')).to_have_value('');expect(page.locator('#note-clear')).to_be_hidden()
    expect(page.locator('#note')).to_be_focused()
    page.locator('#note').fill('虚构新备注');expect(page.locator('#note-clear')).to_be_visible()
    page.locator('#note').blur()
    page.locator('#keypad [data-k="+"]').click();page.locator('#keypad [data-k="2"]').click()
    page.locator('#amount-clear').click();expect(page.locator('#amt')).to_have_text('0.00')
    expect(page.locator('#note')).to_have_value('虚构新备注');expect(page.locator('#date-today')).to_be_visible()
    expect(page.locator('#amount-clear')).to_be_disabled()
    for key in ('2','md','3','='): page.locator(f'#keypad [data-k="{key}"]').click()
    expect(page.locator('#amt')).to_have_text('6')
    page.locator('#date-today').click();expect(page.locator('#date-txt')).to_contain_text('今天')
    expect(page.locator('.dw-panel')).to_have_count(0)
    expect(page.locator('#date-today')).to_be_hidden()
    expect(page.locator('#note')).to_have_value('虚构新备注');expect(page.locator('#amt')).to_have_text('6')
    page.locator('#toast.show').wait_for(state='hidden')
    page.screenshot(path=str(OUT/f'today-{width}-{theme}-{scale}.png'),animations='disabled')
    page.locator('#keypad [data-k="save"]').click();page.locator('#sheet.open').wait_for(state='detached')
    copied=max(rows(page),key=lambda row:row['id'])
    assert copied['amount']==600 and copied['note']=='虚构新备注'
    assert page.evaluate('(at)=>new Date(at).toDateString()===new Date().toDateString()',copied['occurredAt'])
    assert [r for r in rows(page) if r['id'] in range(8101,8105)]==originals
    if width==390:
        page.locator('#sp-entry-view [data-view-action="edit"]').click()
        page.locator('#sheet.open #keypad').wait_for()
        page.locator('#amount-clear').click();expect(page.locator('#amt')).to_have_text('0.00')
        expect(page.locator('#note')).to_have_value('虚构复制备注 <>&')
        page.locator('#sheet-close').click();page.locator('#sheet.open').wait_for(state='detached')
        assert [r for r in rows(page) if r['id'] in range(8101,8105)]==originals
    assert not errors,errors
    context.close();print('PASS copy, note clear, amount clear and today',width,theme,scale,flush=True)

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width,theme,scale in [(360,'light',1),(390,'light',1),(430,'dark',1),(400,'light',1.3),(400,'dark',1.3),(1280,'light',1)]:
            run(browser,width,theme,scale)
        browser.close()
