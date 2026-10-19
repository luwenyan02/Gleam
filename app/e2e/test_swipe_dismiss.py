"""Swipe actions dismiss outside or Back without leaving the owning ledger page."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from test_short_voice import MOCK_NATIVE
from test_refund_layout import SEED,state
from test_refund import swipe_left

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4617/')

def run(browser,width):
    context=browser.new_context(viewport={'width':width,'height':844},timezone_id='Asia/Shanghai',service_workers='block')
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script(MOCK_NATIVE.replace("if (plugin === 'App' && method === 'getInfo') {", "if(plugin==='App' && method==='exitApp'){window.__exits=(window.__exits||0)+1;return {}};if (plugin === 'App' && method === 'getInfo') {"))
    page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED);page.reload()
    row='#hm-days .entry-swipe[data-entry-row="8101"]';page.locator(row).wait_for();before=state(page)
    def opened(selector):
        page.wait_for_function('''s=>{const el=document.querySelector(s+" .entry-swipe-content");
          return el&&getComputedStyle(el).transform==='none';}''',arg=selector)
        swipe_left(page,selector);expect(page.locator(selector)).to_have_class('entry-swipe swipe-open')
    opened(row);page.locator('#page-home .page-head h1').click()
    expect(page.locator('.swipe-open')).to_have_count(0)
    opened(row);page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))')
    expect(page.locator('.swipe-open')).to_have_count(0);expect(page.locator('#page-home')).to_have_class('page is-active')
    assert page.evaluate('window.__exits||0')==0
    opened(row);page.go_back();expect(page.locator('.swipe-open')).to_have_count(0)
    assert state(page)==before
    # An actual action still fires and closes its swipe state, then Back closes only its sheet.
    opened(row);page.locator(row+' [data-entry-action="copy"]').click();page.locator('#keypad').wait_for()
    expect(page.locator('.swipe-open')).to_have_count(0)
    page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))')
    expect(page.locator('#sheet.open')).to_have_count(0);assert state(page)==before
    page.locator('#btn-search').click();page.locator('#sr-input').fill('虚构原账单')
    row='#sr-results .entry-swipe[data-eid="8101"]';page.locator(row).wait_for()
    opened(row);page.locator('#sp-search h2').click();expect(page.locator('.swipe-open')).to_have_count(0)
    opened(row);page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))')
    expect(page.locator('.swipe-open')).to_have_count(0);expect(page.locator('#sp-search.open')).to_have_count(1)
    opened(row);page.go_back();expect(page.locator('.swipe-open')).to_have_count(0)
    expect(page.locator('#sp-search.open')).to_have_count(1)
    page.locator('#sp-search .sub-head [data-act="back"]').click();page.locator('#sp-search').wait_for(state='detached')
    page.locator('#hm-quick .hm-all').click();page.locator('.picker-mask [data-value="detail"]').click()
    row='#sp-entry-detail .entry-swipe[data-id="8101"]';page.locator(row).wait_for()
    opened(row);page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))')
    expect(page.locator('.swipe-open')).to_have_count(0);expect(page.locator('#sp-entry-detail.open')).to_have_count(1)
    page.locator('#sp-entry-detail .sub-head [data-act="back"]').click();page.locator('#sp-entry-detail').wait_for(state='detached')
    page.locator('[data-page="page-acct"]').click();page.locator('#page-acct [data-acct="9001"]').click()
    row='#sp-account-detail .entry-swipe[data-eid="8101"]';page.locator(row).wait_for()
    opened(row);page.locator('#sp-account-detail h2').click();expect(page.locator('.swipe-open')).to_have_count(0)
    opened(row);page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))')
    expect(page.locator('.swipe-open')).to_have_count(0);expect(page.locator('#sp-account-detail.open')).to_have_count(1)
    assert state(page)==before and page.evaluate('window.__exits||0')==0
    assert not errors,errors
    context.close();print('PASS outside/browser/system Back and copy across ledger surfaces',width,flush=True)

if __name__=='__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width in (360,390,430,1280):run(browser,width)
        browser.close()
