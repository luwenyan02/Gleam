"""标签/商家详情、颜色、范围、返回与联想的真实浏览器验收。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from test_acceptance_fixes import seed

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/entities'

def run(page, width):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL); page.wait_for_selector('#fab'); seed(page, count=1, amount=12345)
    page.evaluate('''async () => {
      const db = await new Promise(r => { const q = indexedDB.open('GleamDB'); q.onsuccess = () => r(q.result); });
      const tx = db.transaction(['tags','merchants','entryTags','entries'],'readwrite');
      tx.objectStore('tags').put({id:1,name:'虚构项目',color:'#725BE8',createdAt:1,updatedAt:1});
      tx.objectStore('merchants').put({id:1,name:'虚构商店',useCount:1,createdAt:1,updatedAt:1});
      tx.objectStore('entryTags').put({id:1,entryId:1,tagId:1});
      const q=tx.objectStore('entries').get(1); q.onsuccess=()=>tx.objectStore('entries').put({...q.result,merchantId:1,note:'虚构午餐'});
      await new Promise(r => tx.oncomplete=r); db.close();
    }''')
    page.reload(); page.locator('[data-entry="1"]').click()
    page.locator('[data-view-tag="1"]').click()
    page.locator('.tm-summary').wait_for()
    assert '123.45' in page.locator('.tm-summary').inner_text()
    for scope in ('year','all','month'):
        page.locator(f'[data-scope="{scope}"]').click()
        page.wait_for_timeout(200)
        assert page.locator('[data-insight-entry]').count() == 1
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.wait_for_timeout(250)
        page.screenshot(path=str(OUT / f'tag-{scope}-{width}.png'), animations='disabled')
    page.locator('.tm-trend-point').last.click()
    page.wait_for_function("document.querySelector('#toast')?.textContent.includes('支出')")
    page.locator('[data-insight-edit]').click()
    page.locator('#tm-color').click()
    page.locator('.picker-item[data-value="#3985D5"]').click()
    page.locator('#sheet [data-act="save"]').click(); page.locator('#sheet.open').wait_for(state='detached')
    page.wait_for_function("document.querySelector('.tm-hero-icon')?.style.getPropertyValue('--tag-color') === '#3985D5'")
    page.locator('[data-scope="all"]').click(); page.wait_for_timeout(200)
    page.locator('[data-insight-entry="1"]').click()
    page.locator('#sp-entry-view[aria-hidden="false"] .sub-head [data-act=back]').click()
    page.wait_for_timeout(300)
    assert page.locator('[data-scope="all"]').get_attribute('aria-selected') == 'true'
    page.locator('#sp-entity-insight .sub-head [data-act=back]').click(); page.wait_for_timeout(300)
    page.locator('[data-view-merchant="1"]').click()
    page.locator('.tm-summary').wait_for()
    assert '虚构商店' in page.locator('.tm-insight-hero').inner_text()
    page.wait_for_timeout(350); page.screenshot(path=str(OUT / f'merchant-{width}.png'), animations='disabled')
    page.locator('#sp-entity-insight .sub-head [data-act=back]').click(); page.wait_for_timeout(300)
    page.locator('#sp-entry-view .sub-head [data-act=back]').click(); page.wait_for_timeout(300)
    page.locator('#fab').click()
    page.locator('#note').fill('虚构')
    page.locator('[data-note-idx]').first.click()
    assert page.locator('#note').input_value() == '虚构午餐'
    page.locator('#sheet-close').click()
    assert not errors, errors

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            for width in (360,390,430,1280):
                context = browser.new_context(viewport={'width':width,'height':900}, service_workers='block')
                try:
                    page=context.new_page();page.set_default_timeout(10000)
                    run(page,width);print('PASS entity details',width,flush=True)
                finally:context.close()
        finally:browser.close()
