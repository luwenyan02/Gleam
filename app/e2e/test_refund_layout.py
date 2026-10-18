"""Refund workspace stays usable on short screens and preserves refund accounting."""
import os
import json
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/refund-layout'
SEED = '''async () => {
 const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
 const tx=db.transaction(['entries','accounts','categories'],'readwrite'),stamp={createdAt:1,updatedAt:1};
 const cats=await new Promise(resolve=>{const r=tx.objectStore('categories').getAll();r.onsuccess=()=>resolve(r.result)});
 const original=cats.find(c=>c.name==='晚餐'&&c.kind==='expense');
 if(!original)throw Error('Missing dinner category');
 tx.objectStore('entries').clear();
 tx.objectStore('accounts').put({...stamp,id:9001,group:'cash',name:'虚构退款账户长名称用于检查布局',balance:100000,hidden:false,countInNetWorth:true,sortOrder:1});
 tx.objectStore('categories').put({...stamp,id:9400,kind:'expense',name:'虚构退款分类',icon:'ic-tag',sortOrder:999});
 for(let i=1;i<=40;i++)tx.objectStore('categories').put({...stamp,id:9400+i,parentId:9400,kind:'expense',name:'虚构退款分类'+i,icon:'ic-tag',sortOrder:i});
 tx.objectStore('entries').put({...stamp,id:8101,type:'expense',amount:3680,accountId:9001,categoryId:original.id,
  occurredAt:Date.now()-86400000,note:'虚构原账单',deletedAt:0,reimburseStatus:'none'});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=reject});db.close();return original.id;
}'''


def state(page):
    return page.evaluate('''async()=>{
     const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
     const tx=db.transaction(['entries','accounts']);
     const read=(store)=>new Promise(resolve=>{const r=tx.objectStore(store).getAll();r.onsuccess=()=>resolve(r.result)});
     const [entries,accounts]=await Promise.all([read('entries'),read('accounts')]);db.close();return {entries,accounts};
    }''')


def open_refund(page):
    page.locator('#hm-days [data-entry="8101"]').click()
    page.locator('#sp-entry-view [data-view-action="refund"]').click()
    page.locator('#rf-keypad').wait_for()
    page.wait_for_timeout(350)
    page.evaluate('async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}')


def close_refund(page):
    page.locator('#sp-entry-refund .sub-head [data-act="back"]').click()
    page.locator('#sp-entry-refund').wait_for(state='detached')
    page.locator('#sp-entry-view .sub-head [data-act="back"]').click()
    page.locator('#sp-entry-view').wait_for(state='detached')


def run(browser, width, height, theme, scale, safe):
    context=browser.new_context(viewport={'width':width,'height':height},timezone_id='Asia/Shanghai',
        service_workers='block',device_scale_factor=3 if safe else 1)
    context.add_init_script('''window.__taps=[];Object.defineProperty(navigator,'vibrate',{value:ms=>{window.__taps.push(ms);return true}})''')
    page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(URL);page.locator('#fab').wait_for();category=page.evaluate(SEED)
    page.reload();page.locator('#hm-days [data-entry="8101"]').wait_for()
    page.evaluate('''([theme,scale,safe])=>{document.documentElement.dataset.theme=theme;
     document.documentElement.style.setProperty('--seed-type',scale);document.documentElement.style.setProperty('--safe-bottom',safe+'px')}''',[theme,str(scale),safe])
    original=state(page);open_refund(page)
    keypad=page.locator('#rf-keypad');save=keypad.locator('[data-rk="save"]')
    # Check without Playwright auto-scrolling a hidden save button into view.
    bounds=save.bounding_box()
    if not bounds or abs(bounds['y']+bounds['height']-(height-safe))>=1:
        diagnostic=page.evaluate('''()=>Object.fromEntries(['.app','#sp-entry-refund','.refund-page','.refund-scroll','.refund-meta','#rf-keypad'].map(sel=>{
         const el=document.querySelector(sel),s=getComputedStyle(el);return [sel,{box:el.getBoundingClientRect().toJSON(),margin:s.margin,padding:s.padding,scroll:el.scrollTop}]}))''')
        (OUT/'geometry-failure.json').write_text(json.dumps(diagnostic,indent=2))
    assert bounds and bounds['y']>=0 and abs(bounds['y']+bounds['height']-(height-safe))<1,bounds
    metrics=keypad.evaluate('''el=>{
     const box=k=>el.querySelector(`[data-rk="${k}"]`).getBoundingClientRect().toJSON(),s=getComputedStyle(el);
     const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');canvas.width=canvas.height=1;
     ctx.fillStyle=s.borderTopColor;ctx.fillRect(0,0,1,1);
     return {gap:s.gap,border:s.borderTopWidth,alpha:ctx.getImageData(0,0,1,1).data[3],one:box('1'),zero:box('0'),clear:box('clear'),save:box('save'),
      buttons:[...el.querySelectorAll('button')].map(b=>b.getBoundingClientRect().toJSON())};}''')
    assert metrics['gap']=='1px' and metrics['border']=='1px' and metrics['alpha']==128,metrics
    assert abs(metrics['zero']['top']-metrics['clear']['top'])<1
    assert abs(metrics['clear']['right']+1-metrics['zero']['left'])<1
    assert metrics['save']['height']>=2*metrics['one']['height']
    assert all(b['height']>=44 and b['width']>=44 for b in metrics['buttons'])
    expect(page.locator(f'#rf-cats [data-rf-cat="{category}"]')).to_be_in_viewport(ratio=1)
    assert save.evaluate('''el=>{const r=document.createRange();r.selectNodeContents(el);return r.getClientRects().length}''')==1
    assert page.locator('#rf-cats').evaluate('el=>getComputedStyle(el).gridTemplateColumns.split(" ").length')==5
    assert page.locator('#rf-amount').get_attribute('inputmode')=='none'
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    expect(page.locator('#rf-amount')).to_have_value('36.80')
    page.screenshot(path=str(OUT/f'{width}x{height}-{theme}-{scale}.png'),animations='disabled')

    one=keypad.locator('[data-rk="1"]');idle=one.evaluate('el=>getComputedStyle(el).backgroundColor')
    one.hover();before=page.evaluate('window.__taps.length');page.mouse.down()
    assert one.evaluate('el=>getComputedStyle(el).backgroundColor')!=idle
    expect(page.locator('#rf-amount')).to_have_value('36.80')
    page.mouse.up();expect(page.locator('#rf-amount')).to_have_value('1')
    assert page.evaluate('window.__taps.length')==before+1
    keypad.locator('[data-rk="full"]').click();expect(page.locator('#rf-amount')).to_have_value('36.80')
    keypad.locator('[data-rk="clear"]').click();expect(page.locator('#rf-amount')).to_have_value('')
    keypad.locator('[data-rk="0"]').focus();keypad.locator('[data-rk="0"]').press('Space')
    expect(page.locator('#rf-amount')).to_have_value('0')

    page.locator('#rf-more').click();page.locator('.picker-search input').fill('虚构退款分类39')
    page.locator('.picker-item[data-value="9439"]').click();page.locator('.picker-mask').wait_for(state='detached')
    expect(page.locator('#rf-cats [data-rf-cat="9439"]')).to_have_class('cat sel')
    expect(page.locator('#rf-cats [data-rf-cat="9439"]')).to_be_in_viewport(ratio=1)
    note=page.locator('#rf-note');note.fill('虚构退款备注');expect(keypad).not_to_be_visible()
    page.locator('#rf-note-clear').click();expect(note).to_have_value('')
    note.fill('虚构退款备注');note.blur();expect(keypad).to_be_visible()
    date=page.locator('#rf-date').inner_text();page.locator('#rf-date').click()
    page.locator('.dw-panel').wait_for();page.locator('.dw-mask').click(position={'x':5,'y':5})
    page.locator('.dw-panel').wait_for(state='detached');expect(page.locator('#rf-date')).to_have_text(date)
    page.locator('#rf-account').click()
    expect(page.locator('.entry-account-picker [data-search]')).to_be_focused()
    page.keyboard.press('Escape');page.locator('.entry-account-mask').wait_for(state='detached')
    expect(page.locator('#rf-account')).to_contain_text('虚构退款账户')
    assert save.bounding_box()['y']+save.bounding_box()['height']<=height-safe+1
    assert state(page)==original,'Draft interactions changed the original or balances'
    close_refund(page);assert state(page)==original

    if width==390:
        open_refund(page);page.locator('#rf-amount').fill('99')
        save=page.locator('#rf-keypad [data-rk="save"]');save.click()
        expect(page.locator('#toast.show')).to_contain_text('最多可退');assert state(page)==original
        page.locator('#rf-more').click();page.locator('.picker-search input').fill('虚构退款分类39')
        page.locator('.picker-item[data-value="9439"]').click();page.locator('.picker-mask').wait_for(state='detached')
        page.locator('#rf-amount').fill('12.34');page.locator('#rf-note').fill('虚构部分退款');page.locator('#rf-note').blur()
        save.evaluate('el=>{el.click();el.click()}')
        page.locator('#sp-entry-refund').wait_for(state='detached')
        after=state(page);refunds=[e for e in after['entries'] if e.get('refundFlag')]
        assert len(refunds)==1 and refunds[0]['amount']==1234 and refunds[0]['refundOfEntryId']==8101
        assert refunds[0]['categoryId']==9439 and refunds[0]['note']=='虚构部分退款'
        assert next(a for a in after['accounts'] if a['id']==9001)['balance']==101234
        assert next(e for e in after['entries'] if e['id']==8101)==original['entries'][0]
    assert not errors,errors
    context.close();print('PASS refund layout and draft safety',width,height,theme,scale,safe,flush=True)


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    profiles=[(360,640,'light',1,0),(390,844,'light',1,0),(430,932,'dark',1,0),
        (360,560,'light',1.3,32),(400,810,'dark',1.3,32),(1280,900,'light',1,0)]
    if os.environ.get('GLEAM_REFUND_SMOKE')=='1':profiles=profiles[:1]
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for profile in profiles:run(browser,*profile)
        browser.close()
