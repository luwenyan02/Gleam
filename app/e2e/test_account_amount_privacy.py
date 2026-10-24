"""账户首页金额隐私：虚构资产、无额外查询、切换稳定与小米14排版。"""
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_account_management_ui import SEED

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/account-amount-privacy'


def run(browser, width, height, scale, theme):
    context = browser.new_context(viewport={'width': width, 'height': height},
                                  device_scale_factor=3 if width == 400 else 1,
                                  service_workers='block', reduced_motion='reduce')
    page = context.new_page(); errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://**/*', lambda route: route.abort())
    def appearance():
        page.evaluate('([scale,theme,safe])=>{const s=document.documentElement.style;s.setProperty("--seed-type",scale);s.setProperty("--safe-top",safe);document.documentElement.dataset.theme=theme}', [str(scale), theme, '24px' if width == 400 else '0px'])
    try:
        page.goto(URL); page.locator('#fab').wait_for(); page.evaluate(SEED)
        page.reload(); page.locator('#fab').wait_for()
        appearance()
        page.locator('[data-page="page-acct"]').click()
        home = page.locator('#page-acct'); page.locator('[data-acct="3"]').wait_for()
        assert not re.search(r'¥[\d,]+\.\d{2}', home.inner_text()), 'Default account page exposes amounts'
        toggle = home.locator('[data-account-amount-toggle]')
        expect(toggle).to_have_accessible_name('显示金额')
        expect(toggle).to_have_attribute('aria-pressed', 'false')
        page.locator('[data-net-trend] .balance-trend-line').wait_for(state='attached')
        assert not re.search(r'¥[\d,]+\.\d{2}', home.aria_snapshot()), 'Hidden amounts exposed to accessibility'
        OUT.mkdir(parents=True, exist_ok=True)
        label = f'{width}x{height}-{theme}-{scale}'
        page.screenshot(path=str(OUT/f'hidden-{label}.png'), animations='disabled')
        page.evaluate('''()=>{
          window.__privacyReads=0;
          const original=IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction=function(...args){window.__privacyReads++;return original.apply(this,args)};
          window.__accountRow=document.querySelector('[data-acct="3"]');
        }''')
        toggle.click()
        expect(toggle).to_have_accessible_name('隐藏金额')
        expect(toggle).to_have_attribute('aria-pressed', 'true')
        expect(home.locator('.asset-summary .big')).to_contain_text('-¥9.79')
        assert '剩余额度 ¥9,690.21' in home.inner_text()
        assert page.locator('.acct-net-decimal').evaluate('e=>parseFloat(getComputedStyle(e).fontSize)<parseFloat(getComputedStyle(e.parentElement).fontSize)*.8')
        box = toggle.bounding_box()
        assert box['width'] >= 44 and box['height'] >= 44
        assert home.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
        page.screenshot(path=str(OUT/f'visible-{label}.png'), animations='disabled')
        trend = home.locator('.balance-trend')
        trend.locator('summary').first.click()
        trend.locator('.balance-trend-details summary').click()
        toggle.click()
        assert not re.search(r'¥[\d,]+\.\d{2}', home.inner_text())
        assert not re.search(r'¥[\d,]+\.\d{2}', home.aria_snapshot())
        expect(trend).to_be_hidden()
        toggle.press('Space')
        expect(trend.locator('.balance-trend-values')).to_be_visible()
        trend.locator('summary').first.click()
        home.locator('[data-group="cash"]').click()
        for _ in range(4): toggle.click()
        expect(home.locator('[data-group="cash"]')).to_have_attribute('aria-expanded', 'false')
        assert page.evaluate('window.__privacyReads') == 0, 'Visibility toggle queries the ledger'
        assert page.evaluate('window.__accountRow===document.querySelector(\'[data-acct="3"]\')')
        page.locator('[data-page="page-mine"]').click(); page.locator('[data-page="page-acct"]').click()
        expect(toggle).to_have_attribute('aria-pressed', 'true')
        # Editing/re-rendering must retain privacy; details remain readable by explicit navigation.
        toggle.click(); home.locator('[data-acct="3"]').click()
        expect(page.locator('.credit-limit-side')).to_contain_text('¥9,690.21')
        page.locator('[data-account-action="edit"]').click()
        page.locator('#af-name').fill('虚构信用卡改名')
        page.locator('#sheet [data-act="save"]').click()
        expect(page.locator('#sheet')).not_to_have_class(re.compile(r'\bopen\b'))
        page.locator('#sp-account-detail .sub-head [data-act="back"]').click()
        expect(home.locator('[data-acct="3"]')).to_contain_text('虚构信用卡改名')
        expect(toggle).to_have_attribute('aria-pressed', 'false')
        toggle.click(); page.reload(); page.locator('#fab').wait_for()
        appearance()
        page.locator('[data-page="page-acct"]').click()
        expect(home.get_by_role('button', name='显示金额', exact=True)).to_be_visible()
        assert not re.search(r'¥[\d,]+\.\d{2}', home.inner_text())
        page.evaluate('''async()=>{
          const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
          const tx=db.transaction('accounts','readwrite'),store=tx.objectStore('accounts'),r=store.get(1);
          r.onsuccess=()=>store.put({...r.result,balance:456601894});
          await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
        }''')
        page.reload(); page.locator('#fab').wait_for(); appearance(); page.locator('[data-page="page-acct"]').click()
        home.get_by_role('button', name='显示金额', exact=True).click()
        expect(home.locator('.asset-summary .big')).to_contain_text('¥4,565,909.15')
        assert home.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
        assert page.locator('.acct-net-row').evaluate('e=>{const a=e.querySelector(".big").getBoundingClientRect(),b=e.querySelector("button").getBoundingClientRect();return a.right<=b.left&&b.right<=e.getBoundingClientRect().right+1}')
        page.screenshot(path=str(OUT/f'large-{label}.png'), animations='disabled')
        assert not errors, errors
        print('PASS account amount privacy', label, flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch()
        profiles = [(400,890,1,'light'),(400,890,1,'dark'),(400,810,1.3,'light'),(400,810,1.3,'dark'),
                    (360,844,1,'light'),(390,844,1,'light'),(430,932,1,'dark'),(1280,900,1,'light')]
        for profile in profiles: run(browser, *profile)
        browser.close()
