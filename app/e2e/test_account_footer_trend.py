"""Account history controls and smooth trends at phone sizes; fictional ledger only."""
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright
from test_account_management_ui import SEED

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4602/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/account-footer-trend'


def bottom_controls(page):
    body = page.locator('#sp-account-detail .sub-body')
    body.evaluate('e => e.scrollTop = e.scrollHeight')
    page.wait_for_timeout(100)
    footer = page.locator('#account-detail-entry').bounding_box()
    for action in ['all-months', 'more-months']:
        button = page.locator(f'[data-account-action="{action}"]')
        box = button.bounding_box()
        assert box['y'] + box['height'] <= footer['y'] - 8, 'History controls overlap the entry button'
        assert button.evaluate('e => {const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.bottom-3))}'), 'History control is covered'
    assert footer['y'] + footer['height'] <= page.viewport_size['height']
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')


def run(browser, width, height, scale, safe, theme):
    context = browser.new_context(viewport={'width': width, 'height': height}, device_scale_factor=3 if width == 400 else 1,
                                  locale='zh-CN', timezone_id='Asia/Shanghai', service_workers='block', reduced_motion='reduce')
    external, errors = [], []
    context.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(URL).netloc else (external.append(r.request.url), r.abort()))
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.locator('#fab').wait_for()
    page.evaluate(SEED)
    page.evaluate("""async () => {
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction(['entries','accounts'],'readwrite');
      const account=tx.objectStore('accounts').get(1);
      account.onsuccess=()=>tx.objectStore('accounts').put({...account.result,balance:35155});
      const now=new Date();
      for(let i=0;i<20;i++){
        const delta=[0,0,0,22000,-24000,0][i%6];
        tx.objectStore('entries').put({id:i+1,type:delta<0?'expense':'income',amount:Math.abs(delta),accountId:1,
          occurredAt:new Date(now.getFullYear(),now.getMonth()-i,5,12).getTime(),
          note:'虚构账户走势',reimburseStatus:'none',deletedAt:0,createdAt:1,updatedAt:1});
      }
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
    }""")
    page.reload()
    page.locator('#fab').wait_for()
    page.evaluate('([scale,safe,theme]) => {const s=document.documentElement.style;s.setProperty("--seed-type",scale);s.setProperty("--safe-bottom",safe+"px");s.setProperty("--safe-top",safe?"24px":"0px");document.documentElement.dataset.theme=theme}', [str(scale), safe, theme])
    page.locator('[data-page="page-acct"]').click()
    page.locator('[data-acct="1"]').click()
    expect(page.locator('.account-month')).to_have_count(8)
    bottom_controls(page)
    label = f'{width}x{height}-text{scale}-safe{safe}-{theme}'
    page.screenshot(path=str(OUT / f'bottom-{label}.png'), animations='disabled')
    page.locator('[data-account-action="more-months"]').click()
    expect(page.locator('.account-month')).to_have_count(16)
    bottom_controls(page)
    page.locator('[data-account-action="all-months"]').click()
    expect(page.locator('.account-month')).to_have_count(20)
    page.locator('#sp-account-detail .sub-body').evaluate('e=>e.scrollTop=e.scrollHeight')
    last = page.locator('.account-month').last.bounding_box()
    footer = page.locator('#account-detail-entry').bounding_box()
    assert last['y'] + last['height'] < footer['y'] - 8
    page.locator('#account-detail-entry').click()
    expect(page.locator('#acct-name')).to_have_text('虚构现金甲')
    page.locator('#sheet-close').click()
    page.locator('#sp-account-detail .balance-trend-heading').click()
    expect(page.locator('#sp-account-detail .balance-trend-range')).to_have_count(0)
    line = page.locator('#sp-account-detail .balance-trend-line')
    expect(line).to_have_js_property('tagName', 'path')
    assert line.get_attribute('d').count('C') == 5
    page.locator('#sp-account-detail .balance-trend-details summary').click()
    expect(page.locator('#sp-account-detail .balance-trend-values li')).to_have_count(6)
    expect(page.locator('#sp-account-detail .balance-trend-values li').last).to_contain_text('¥351.55')
    line.scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / f'trend-{label}.png'), animations='disabled')
    page.locator('#sp-account-detail [data-trend-shift="-6"]').click()
    expect(page.locator('#sp-account-detail [data-trend-shift="6"]')).to_be_enabled()
    expect(page.locator('#sp-account-detail path.balance-trend-line')).to_be_visible()
    page.locator('#sp-account-detail .sub-head [data-act="back"]').click()
    page.locator('[data-acct="1"]').click()
    expect(page.locator('#account-detail-entry')).to_have_count(1)
    assert not errors, errors
    assert not external, external
    context.close()
    print('PASS account footer and smooth trend', label, flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width, height, scale, safe in [(400, 890, 1, 24), (400, 810, 1.3, 32), (360, 844, 1, 24), (390, 844, 1, 0), (430, 900, 1, 24), (1280, 900, 1, 0)]:
            for theme in ['light', 'dark']:
                run(browser, width, height, scale, safe, theme)
        browser.close()
