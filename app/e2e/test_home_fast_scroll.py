"""Fast-scroll gestures never query data; only an explicit list pull expands the loaded months."""
import os
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import expect, sync_playwright
from test_home_monthly_timeline import SEED
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/home-fast-scroll'


def reveal(page):
    home = page.locator('#page-home')
    direction = home.evaluate('e=>e.scrollHeight-e.clientHeight-e.scrollTop<2600?-1:1')
    box = home.bounding_box()
    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    for _ in range(7):
        page.mouse.wheel(0, direction * 100)
        page.wait_for_timeout(70)
    expect(page.locator('.hm-fast-scroll')).to_be_visible(timeout=500)


def track_reads(page):
    page.evaluate("""()=>{
      window.ledgerReads=0;
      for(const proto of [IDBObjectStore.prototype,IDBIndex.prototype])
        for(const name of ['get','getKey','getAll','getAllKeys','getAllRecords','openCursor','openKeyCursor','count']) {
          const original=proto[name]; if(!original)continue;
          proto[name]=function(...args){
            if(['entries','lifeNotes'].includes(this.objectStore?.name??this.name))window.ledgerReads++;
            return original.apply(this,args);
          };
        }
    }""")


def run(browser, width, theme='light', scale=1):
    context = browser.new_context(viewport={'width': width, 'height': 844}, has_touch=True,
        locale='zh-CN', timezone_id='Asia/Shanghai', service_workers='block', reduced_motion='reduce')
    errors, external = [], []
    context.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(URL).netloc else (external.append(r.request.url), r.abort()))
    page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.set_fixed_time(datetime.fromisoformat('2026-10-18T12:00:00+08:00'))
    try:
        page.goto(URL); page.locator('#fab').wait_for()
        page.evaluate(SEED, 5); page.reload()
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(60)
        page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",scale)}', [theme,str(scale)])
        home = page.locator('#page-home'); controls = page.locator('.hm-fast-scroll')
        top = controls.get_by_role('button', name='回到顶部')
        bottom = controls.get_by_role('button', name='直达底部')
        slider = controls.get_by_role('slider', name='拖动快速浏览流水')
        expect(controls).to_be_hidden()
        # Scripted jumps, slow scrolling, and a short flick do not reveal it.
        home.evaluate('e=>e.scrollTop=600'); page.wait_for_timeout(150)
        expect(controls).to_be_hidden()
        page.mouse.move(width / 2, 480)
        for _ in range(17):
            page.mouse.wheel(0, 5); page.wait_for_timeout(75)
        expect(controls).to_be_hidden()
        for _ in range(2):
            page.mouse.wheel(0, 100); page.wait_for_timeout(70)
        expect(controls).to_be_hidden()
        page.wait_for_timeout(900)
        reveal(page)
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(60)
        box = controls.bounding_box(); viewport = home.bounding_box()
        assert box['width'] >= 48
        assert viewport['x'] + viewport['width'] - box['x'] - box['width'] >= 12
        assert .5 < (box['y'] + box['height']/2 - viewport['y']) / viewport['height'] < .75
        assert_usable(page, '.hm-fast-scroll')
        page.screenshot(path=str(OUT/f'flow-{width}-{theme}-{scale}.png'), animations='disabled')
        track_reads(page)
        # Hide even if a prior pointer click focused a control; touching it keeps it alive.
        box = slider.bounding_box(); x = box['x'] + box['width']/2; y = box['y'] + box['height']/2
        before = home.evaluate('e=>e.scrollTop')
        page.mouse.move(x,y); page.mouse.down(); page.wait_for_timeout(1000)
        expect(controls).to_be_visible()
        page.mouse.move(x,y+65,steps=8); page.mouse.up()
        assert home.evaluate('e=>e.scrollTop') > before + 300
        expect(page.locator('#sheet.open')).to_have_count(0)
        bottom.click()
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(60)
        expect(page.locator('#hm-more')).to_have_text('再上拉加载2026年7月')
        page.wait_for_function('(()=>{const e=document.querySelector("#page-home");return e.scrollHeight-e.clientHeight-e.scrollTop<3})()')
        expect(page.locator('[data-entry-row="41"]')).to_be_in_viewport()
        expect(bottom).to_be_disabled()
        top.click(); page.wait_for_function('document.querySelector("#page-home").scrollTop<2')
        expect(top).to_be_disabled()
        slider.focus(); slider.press('ArrowDown')
        assert home.evaluate('e=>e.scrollTop') > 100
        page.wait_for_timeout(900); expect(controls).to_be_visible()
        slider.press('Home'); page.wait_for_function('document.querySelector("#page-home").scrollTop<2')
        page.mouse.click(width / 2, 260)
        page.wait_for_timeout(1000); expect(controls).to_be_hidden()
        # Continuous native touch scrolling must also reveal the capsule.
        if width == 390:
            cdp = context.new_cdp_session(page)
            for _ in range(3):
                cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':170,'y':680}]})
                for i in range(1,13):
                    cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':170,'y':680-i*30}]})
                    page.wait_for_timeout(40)
                cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
            expect(controls).to_be_visible()
        else:
            reveal(page)
        # Native touch can drag the grip without starting pagination or losing capture.
        if width == 390:
            box = slider.bounding_box()
            x, y = box['x']+24, box['y']+24
            before = home.evaluate('e=>e.scrollTop')
            cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
            for i in range(1,9):
                cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':x,'y':y+i*8}]})
            cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
            assert home.evaluate('e=>e.scrollTop') > before+300
            assert not controls.evaluate('el=>el.classList.contains("is-dragging")')
        slider.focus(); slider.press('End'); slider.press(' '); slider.press('PageDown')
        page.wait_for_timeout(200)
        assert page.evaluate('ledgerReads') == 0
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(60)
        top.click(); page.locator('#btn-search').click(); expect(controls).to_be_hidden()
        page.locator('#sp-search [data-act="back"]').click()
        page.locator('#sp-search').wait_for(state='detached'); expect(controls).to_be_hidden()
        page.locator('[data-page="page-acct"]').click(); expect(controls).to_be_hidden()
        page.locator('[data-page="page-home"]').click(); expect(controls).to_be_hidden()
        page.evaluate('''async()=>{
          const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
          const tx=db.transaction(['entries','lifeNotes'],'readwrite');tx.objectStore('entries').clear();tx.objectStore('lifeNotes').clear();
          await new Promise(r=>tx.oncomplete=r);db.close();
        }''')
        page.reload(); expect(page.locator('#hm-days [data-entry-row]')).to_have_count(0)
        expect(controls).to_be_hidden()
        assert not errors, errors
        assert not external, external
        print(f'PASS home fast scroll {width}px {theme} text {scale}', flush=True)
    finally: context.close()


def long_history(browser):
    context=browser.new_context(viewport={'width':390,'height':844},locale='zh-CN',timezone_id='Asia/Shanghai',service_workers='block',reduced_motion='reduce')
    page=context.new_page(); errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
    context.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc==urlsplit(URL).netloc else r.abort())
    try:
        page.clock.set_fixed_time(datetime.fromisoformat('2026-10-18T12:00:00+08:00'))
        page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED,5)
        page.evaluate('''async()=>{
          const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
          const tx=db.transaction(['entries','lifeNotes'],'readwrite');const entries=tx.objectStore('entries');entries.clear();
          for(let i=0;i<10000;i++)entries.put({id:i+1,type:'expense',amount:1200,accountId:1,categoryId:1,note:'虚构历史流水',occurredAt:new Date(2026,9-Math.floor(i/250),10,12).getTime()+i,deletedAt:0,reimburseStatus:'none',createdAt:1,updatedAt:1});
          const notes=tx.objectStore('lifeNotes');notes.clear();
          notes.put({id:991,kind:'diary',title:'最早的生活记录',body:'虚构内容',occurredAt:new Date(2022,2,3).getTime(),deletedAt:0,createdAt:1,updatedAt:1});
          notes.put({id:992,kind:'diary',title:'已删除的更早记录',body:'不应出现',occurredAt:new Date(2020,0,1).getTime(),deletedAt:1,createdAt:1,updatedAt:1});
          await new Promise(r=>tx.oncomplete=r);db.close();
        }''')
        page.reload();expect(page.locator('#hm-days [data-entry-row]')).to_have_count(750)
        controls=page.locator('.hm-fast-scroll');home=page.locator('#page-home')
        cdp=context.new_cdp_session(page);cdp.send('Emulation.setCPUThrottlingRate',{'rate':4})
        reveal(page); track_reads(page)
        start=time.monotonic();controls.get_by_role('button',name='直达底部').click()
        page.wait_for_function('(()=>{const e=document.querySelector("#page-home");return e.scrollHeight-e.clientHeight-e.scrollTop<3})()')
        elapsed=time.monotonic()-start
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(750)
        expect(page.locator('[data-entry-row="501"]')).to_be_in_viewport()
        expect(page.locator('[data-home-life-note="991"]')).to_have_count(0)
        expect(page.locator('#hm-more')).to_have_text('再上拉加载2026年7月')
        slider=controls.get_by_role('slider')
        slider.focus();slider.press('Home');slider.press('End');slider.press('PageDown');slider.press(' ')
        page.wait_for_timeout(300)
        box=slider.bounding_box();page.mouse.move(box['x']+24,box['y']+24)
        page.mouse.wheel(0,120);page.wait_for_timeout(250)
        assert page.evaluate('ledgerReads')==0
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(750)
        # A new upward pull on the list (outside the capsule) still loads exactly one month.
        page.mouse.move(180,500);page.mouse.wheel(0,120)
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(1000)
        expect(page.locator('#hm-more')).to_have_text('再上拉加载2026年6月')
        page.wait_for_timeout(500)
        reveal(page);page.evaluate('ledgerReads=0')
        controls.get_by_role('button',name='直达底部').click()
        page.wait_for_function('(()=>{const e=document.querySelector("#page-home");return e.scrollHeight-e.clientHeight-e.scrollTop<3})()')
        controls.get_by_role('button',name='回到顶部').click()
        page.wait_for_function('document.querySelector("#page-home").scrollTop<2')
        expect(page.locator('[data-entry-row="250"]')).to_be_visible()
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(1000)
        assert page.evaluate('ledgerReads')==0
        start=time.monotonic()
        for _ in range(3):
            page.locator('[data-page="page-mine"]').click();expect(page.locator('#page-mine')).to_have_class('page is-active')
            page.locator('[data-page="page-home"]').click()
            expect(page.locator('[data-entry-row="250"]')).to_be_visible()
        tabs=(time.monotonic()-start)/3
        page.locator('[data-entry="250"]').click();expect(page.locator('#sp-entry-view .entry-view-hero')).to_contain_text('-12.00')
        page.locator('#sp-entry-view [data-act="back"]').click();expect(page.locator('#sp-entry-view')).to_have_count(0)
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(1000)
        assert not errors,errors
        print(f'PASS 10000 stored rows: capsule zero reads, loaded 750 unchanged; explicit pull adds 250, capsule retains 1000; jump {elapsed:.2f}s, tab roundtrip {tabs:.2f}s',flush=True)
    finally:context.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width,theme,scale in [(360,'light',1),(390,'light',1),(430,'dark',1.3),(1280,'light',1)]:
            run(browser,width,theme,scale)
        long_history(browser)
        browser.close()
