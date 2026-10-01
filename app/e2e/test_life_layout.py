"""拾光页：月份选择、历史记录、底部入口与多宽度遮挡验收。仅使用虚构记录。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:5173/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/life-layout'


def heading_gap(page, title, subtitle):
    page.locator(title).wait_for(state='visible')
    page.wait_for_timeout(300)
    title_box = page.locator(title).bounding_box()
    subtitle_box = page.locator(subtitle).bounding_box()
    return subtitle_box['y'] - title_box['y'] - title_box['height']


def run(page, width):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL)
    home_gap = heading_gap(page, '#page-home .brand', '#page-home .page-head .sub')
    page.locator('[data-page="page-acct"]').click()
    account_gap = heading_gap(page, '#page-acct .brand', '#page-acct .page-head .sub')
    page.locator('[data-page="page-life"]').click()
    page.locator('#lf-month').wait_for()
    life_gap = heading_gap(page, '.lf-header .brand', '.lf-tagline')
    assert abs(life_gap - home_gap) < 0.5, (width, life_gap, home_gap)
    assert abs(life_gap - account_gap) < 0.5, (width, life_gap, account_gap)
    title_box = page.locator('.lf-header .brand').bounding_box()
    tagline_box = page.locator('.lf-tagline').bounding_box()
    month_box = page.locator('.lf-month-nav').bounding_box()
    assert abs(title_box['x'] - tagline_box['x']) < 0.5
    assert title_box['x'] + title_box['width'] + 8 <= month_box['x']
    assert tagline_box['x'] + tagline_box['width'] + 8 <= month_box['x']
    assert page.locator('.lf-tagline').evaluate('el => el.scrollWidth <= el.clientWidth + 1')
    assert tagline_box['height'] < 21, (width, tagline_box)
    assert page.locator('[data-page="page-life"]').inner_text() == '拾光'
    assert page.locator('#lf-next').is_disabled()
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / f'empty-{width}.png'))
    current = page.locator('#lf-sub').inner_text()
    page.locator('#lf-month').click()
    page.locator('.dw-panel.dw-open[role="dialog"]').wait_for()
    page.locator('.dw-col').first.press('ArrowUp')
    page.locator('.dw-col').last.press('Home')
    page.locator('.dw-confirm').click()
    page.locator('.dw-panel').wait_for(state='detached')
    year = page.evaluate('new Date().getFullYear() - 1')
    page.wait_for_function('(year) => document.querySelector("#lf-sub").textContent === `${year}年1月`', arg=year)
    page.locator('#lf-prev').click()
    page.wait_for_function('(year) => document.querySelector("#lf-sub").textContent === `${year-1}年12月`', arg=year)
    page.locator('#lf-next').click()
    page.wait_for_function('(year) => document.querySelector("#lf-sub").textContent === `${year}年1月`', arg=year)
    page.locator('#lf-month').click()
    page.locator('.dw-panel.dw-open[role="dialog"]').wait_for()
    page.locator('.dw-col').last.press('End')
    page.locator('.dw-col').last.press('Escape')
    page.locator('.dw-panel').wait_for(state='detached')
    assert page.locator('#lf-sub').inner_text() == f'{year}年1月'
    page.locator('#fab-life').click()
    page.locator('#life-chat-input').wait_for()
    assert page.locator('#fab-life').evaluate('el => el.inert')
    page.locator('#sp-life-chat .sub-head [data-act="back"]').click()
    page.locator('#sp-life-chat').wait_for(state='detached')
    assert page.locator('#lf-sub').inner_text() == f'{year}年1月'
    # 回到当月并注入长时间线，检查底部入口稳定且尾部记录可完整滚出。
    page.locator('#lf-month').click()
    page.locator('.dw-panel.dw-open[role="dialog"]').wait_for()
    page.locator('.dw-col').first.press('End')
    page.locator('.dw-col').last.press('End')
    page.locator('.dw-confirm').click()
    page.locator('.dw-panel').wait_for(state='detached')
    page.wait_for_function('(text) => document.querySelector("#lf-sub").textContent === text', arg=current)
    page.evaluate('''async () => {
      const db = await new Promise(r => { const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result); });
      const tx=db.transaction('lifeNotes','readwrite');
      for(let i=0;i<16;i++) tx.objectStore('lifeNotes').put({id:910000+i,kind:'diary',title:`虚构片段 ${i}`,body:'一阵晚风，和一段慢慢走回家的路。',occurredAt:Date.now()-i*1000,createdAt:1,updatedAt:1,deletedAt:0});
      await new Promise(r=>tx.oncomplete=r);db.close();
    }''')
    page.locator('[data-page="page-mine"]').click()
    assert not page.locator('#fab-life').is_visible()
    page.locator('[data-page="page-life"]').click()
    page.locator('#lf-feed [data-note]').first.wait_for()
    dock = page.locator('#fab-life').bounding_box()
    page.locator('#lf-types').scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    last = page.locator('#lf-feed [data-note]').last.bounding_box()
    assert last['y'] + last['height'] <= dock['y'], (last, dock)
    assert page.locator('#fab-life').bounding_box() == dock
    page.screenshot(path=str(OUT / f'feed-bottom-{width}.png'))
    page.locator('#lf-month').scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    assert page.locator('#page-life').evaluate('el => el.scrollWidth <= el.clientWidth + 1')
    for button in page.locator('.lf-header button, .lf-tools button, #fab-life').all():
        box = button.bounding_box()
        assert box['width'] >= 44 and box['height'] >= 44, box
    page.screenshot(path=str(OUT / f'feed-{width}.png'))
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1024):
            context = browser.new_context(viewport={'width':width,'height':844})
            run(context.new_page(), width)
            context.close()
            print(f'PASS life layout {width}', flush=True)
        browser.close()
