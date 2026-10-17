"""标签/商家详情、颜色、范围、返回与联想的真实浏览器验收。"""
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from test_acceptance_fixes import seed

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/entities'

def merchant_list_layout(page, width):
    merchants = [
        {'id': 21, 'name': '虚构小店', 'useCount': 7},
        {'id': 22, 'name': '虚构商家这是导入账单中的很长很长的分店名称', 'useCount': 12},
        {'id': 23, 'name': 'FictionalMerchantWithAVeryLongUnbrokenBranchName', 'useCount': 999},
        {'id': 24, 'name': '虚构新店', 'useCount': 0},
        {'id': 25, 'name': '虚构高频商家', 'useCount': 10000},
    ]
    page.evaluate('''async merchants => {
      const db = await new Promise(resolve => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction('merchants', 'readwrite');
      const store = tx.objectStore('merchants'); store.clear();
      for (const merchant of merchants) store.put({...merchant, createdAt: 1, updatedAt: 1});
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
    }''', merchants)
    page.reload(); page.locator('#fab').wait_for()
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-tags"]').click()
    expect(page.locator('[data-open-shop]')).to_have_count(len(merchants))
    for scale in (1, 1.3):
        page.evaluate('scale => document.documentElement.style.setProperty("--seed-type", String(scale))', scale)
        page.wait_for_timeout(350)
        counts = page.locator('#tm-shops .row-note').evaluate_all('''els => els.map(el => {
          const r = document.createRange(); r.selectNodeContents(el);
          const rects = [...r.getClientRects()];
          return {right: r.getBoundingClientRect().right, lines: rects.length};
        })''')
        assert max(c['right'] for c in counts) - min(c['right'] for c in counts) <= 1, counts
        assert all(c['lines'] == 1 for c in counts), counts
        for merchant in merchants:
            row = page.locator(f'[data-open-shop="{merchant["id"]}"]')
            expect(row.locator('.tm-shop-name')).to_have_text(merchant['name'])
            expect(row.locator('.row-note')).to_have_text(f'用过 {merchant["useCount"]} 次')
            name = row.locator('.tm-shop-name').bounding_box()
            count = row.locator('.row-note').bounding_box()
            arrow = row.locator('.chev').bounding_box()
            edit = page.locator(f'[data-edit-shop="{merchant["id"]}"]').bounding_box()
            assert name['width'] > 0 and name['x'] + name['width'] + 8 <= count['x']
            assert count['x'] + count['width'] + 8 <= arrow['x']
            assert arrow['x'] + arrow['width'] <= edit['x']
            assert edit['width'] >= 44 and edit['height'] >= 44
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(OUT / f'merchant-list-{width}-{scale}.png'), animations='disabled')
    page.evaluate('document.documentElement.style.removeProperty("--seed-type")')
    page.locator('[data-edit-shop="22"]').click()
    expect(page.locator('#tm-name')).to_have_value(merchants[1]['name'])
    page.locator('#sheet [data-act="close"]').click()
    page.locator('#sheet.open').wait_for(state='detached')
    page.locator('[data-open-shop="22"]').click()
    expect(page.locator('.tm-insight-hero h3')).to_have_text(merchants[1]['name'])
    page.locator('#sp-entity-insight .sub-head [data-act="back"]').click()
    expect(page.locator('#sp-tags[aria-hidden="false"] [data-open-shop]')).to_have_count(len(merchants))

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
    page.locator('#note').blur()
    assert page.locator('[data-note-idx],#note-suggest').count() == 0
    assert page.locator('#note').input_value() == '虚构'
    page.locator('#sheet-close').click()
    page.locator('#sheet.open').wait_for(state='detached')
    merchant_list_layout(page, width)
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
