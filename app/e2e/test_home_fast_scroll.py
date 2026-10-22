"""Home fast navigation: real scrolling, isolated fictional ledger, no external services."""
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
        home = page.locator('#page-home')
        controls = page.get_by_role('group', name='快速浏览流水')
        expect(controls).to_be_visible()
        top = controls.get_by_role('button', name='回到顶部')
        bottom = controls.get_by_role('button', name='直达底部')
        slider = controls.get_by_role('slider', name='拖动快速浏览流水')
        expect(top).to_be_disabled()
        page.wait_for_timeout(300)
        initial_height = home.evaluate('e=>e.scrollHeight')
        # Ordinary scrolling outside the small control stays native and does not expand history.
        page.mouse.move(width / 2, 480); page.mouse.wheel(0, 1000)
        page.wait_for_function('document.querySelector("#page-home").scrollTop>600')
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(60)
        assert home.evaluate('e=>e.scrollHeight') == initial_height
        box = controls.bounding_box(); viewport = home.bounding_box()
        assert box['x'] > viewport['x'] + viewport['width'] * .75
        assert .5 < (box['y'] + box['height']/2 - viewport['y']) / viewport['height'] < .75
        assert_usable(page, '.hm-fast-scroll')
        page.screenshot(path=str(OUT/f'flow-{width}-{theme}-{scale}.png'), animations='disabled')
        # Dragging the grip moves by a large fraction of the list, not only 80px.
        box = slider.bounding_box(); x = box['x'] + box['width']/2; y = box['y'] + box['height']/2
        before = home.evaluate('e=>e.scrollTop')
        page.mouse.move(x,y); page.mouse.down(); page.mouse.move(x,y+80,steps=8); page.mouse.up()
        assert home.evaluate('e=>e.scrollTop') > before + 500
        expect(page.locator('#sheet.open')).to_have_count(0)
        # Button loads all remaining months once, including the oldest effective record.
        bottom.click()
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(140)
        expect(page.locator('#hm-more')).to_have_text('已展示全部流水')
        page.wait_for_function('(()=>{const e=document.querySelector("#page-home");return e.scrollHeight-e.clientHeight-e.scrollTop<3})()')
        expect(page.locator('[data-entry-row="121"]')).to_be_in_viewport()
        expect(bottom).to_be_disabled()
        top.click()
        page.wait_for_function('document.querySelector("#page-home").scrollTop<2')
        expect(top).to_be_disabled()
        slider.focus(); slider.press('ArrowDown')
        assert home.evaluate('e=>e.scrollTop') > 100
        slider.press('Home'); page.wait_for_function('document.querySelector("#page-home").scrollTop<2')
        # Native browser touch delivery: ordinary swipes work, while the grip captures its own drag.
        if width == 390:
            cdp = context.new_cdp_session(page)
            def swipe(x, y, target):
                cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
                for i in range(1,9):
                    cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':x,'y':y+(target-y)*i/8}]})
                cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
            swipe(180,600,300)
            page.wait_for_function('document.querySelector("#page-home").scrollTop>100')
            top.click(); page.wait_for_function('document.querySelector("#page-home").scrollTop<2')
            box=slider.bounding_box(); before=home.evaluate('e=>e.scrollTop')
            swipe(box['x']+22,box['y']+22,box['y']+102)
            assert home.evaluate('e=>e.scrollTop') > before+500
            assert not controls.evaluate('el=>el.classList.contains("is-dragging")')
            top.click()
        # Hidden while another page / subpage is active, without stealing touch targets.
        page.locator('#btn-search').click(); expect(controls).to_be_hidden()
        page.locator('#sp-search [data-act="back"]').click()
        page.locator('#sp-search').wait_for(state='detached'); expect(controls).to_be_visible()
        page.locator('[data-page="page-acct"]').click(); expect(controls).to_be_hidden()
        page.locator('[data-page="page-home"]').click(); expect(controls).to_be_visible()
        # Empty / short data refresh removes the control; deleted history must not extend the list.
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
    finally:
        context.close()


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
          for(let i=0;i<5000;i++)entries.put({id:i+1,type:'expense',amount:1200,accountId:1,categoryId:1,note:'虚构历史流水',occurredAt:new Date(2026,9-Math.floor(i/250),10,12).getTime()+i,deletedAt:0,reimburseStatus:'none',createdAt:1,updatedAt:1});
          const notes=tx.objectStore('lifeNotes');notes.clear();
          notes.put({id:991,kind:'diary',title:'最早的生活记录',body:'虚构内容',occurredAt:new Date(2023,2,3).getTime(),deletedAt:0,createdAt:1,updatedAt:1});
          notes.put({id:992,kind:'diary',title:'已删除的更早记录',body:'不应出现',occurredAt:new Date(2020,0,1).getTime(),deletedAt:1,createdAt:1,updatedAt:1});
          await new Promise(r=>tx.oncomplete=r);db.close();
        }''')
        page.reload();expect(page.locator('#hm-days [data-entry-row]')).to_have_count(750)
        controls=page.get_by_role('group',name='快速浏览流水')
        start=time.monotonic();controls.get_by_role('button',name='直达底部').click()
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(5000,timeout=20000)
        expect(page.locator('[data-home-life-note="991"]')).to_be_in_viewport(timeout=10000)
        expect(page.locator('#hm-more')).to_have_text('已展示全部流水')
        expect(page.locator('[data-home-life-note="992"]')).to_have_count(0)
        elapsed=time.monotonic()-start
        page.wait_for_function('(()=>{const e=document.querySelector("#page-home");return e.scrollHeight-e.clientHeight-e.scrollTop<3})()')
        controls.get_by_role('button',name='回到顶部').click()
        page.wait_for_function('document.querySelector("#page-home").scrollTop<2')
        assert not errors,errors
        print(f'PASS 5000 rows, multi-year history, life-only earliest date, deleted exclusion; jump {elapsed:.2f}s',flush=True)
    finally:context.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width,theme,scale in [(360,'light',1),(390,'light',1),(430,'dark',1.3),(1280,'light',1)]:
            run(browser,width,theme,scale)
        long_history(browser)
        browser.close()
