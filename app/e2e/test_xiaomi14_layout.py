"""Xiaomi 14 sized browser simulation: 1200x2670 physical pixels at DPR3.

The real device's WebView density/insets depend on system display settings. These
cases cover 400/393 logical widths, safe-area/keyboard space and 130% app typography;
this is not a claim of physical phone or real software-keyboard testing.
"""
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from test_entry_account_picker import SEED
URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4602/')
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/xiaomi14'

def run(page,width,height,scale,theme):
 errors=[];external=[];page.on('pageerror',lambda e:errors.append(str(e)));page.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc==urlsplit(URL).netloc else (external.append(r.request.url),r.abort()))
 page.add_init_script(f"document.addEventListener('DOMContentLoaded',()=>{{document.documentElement.style.setProperty('--safe-top','24px');document.documentElement.style.setProperty('--safe-bottom','24px');document.documentElement.style.setProperty('--seed-type','{scale}');document.documentElement.dataset.theme='{theme}';}})")
 page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED);page.reload();page.locator('#fab').wait_for();page.evaluate('(t)=>document.documentElement.dataset.theme=t',theme)
 label=f'{width}x{height}-text{scale}-{theme}'
 page.locator('#fab').click();page.locator('#note').fill('虚构小米尺寸草稿');page.locator('#note').blur();page.locator('[data-k="8"]').click()
 # Four rows retain a single aligned line per label; ellipsis never changes row height.
 expect(page.locator('#cat-grid .cat')).to_have_count(20)
 assert page.locator('#cat-grid').evaluate('e=>getComputedStyle(e).gridTemplateColumns.split(" ").length')==5
 assert page.locator('#cat-grid .cat>span:last-child').evaluate_all('(els)=>els.every(e=>getComputedStyle(e).whiteSpace==="nowrap")')
 assert page.locator('#sheet').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
 page.screenshot(path=str(OUT/f'entry-{label}.png'),animations='disabled')
 page.locator('#acct-btn').click();panel=page.locator('.entry-account-picker');panel.wait_for();page.wait_for_timeout(200);original=panel.bounding_box()['height'];panel.locator('[data-search]').click();search=panel.locator('input[type=search]');search.fill('没有此虚构账户')
 expect(panel.locator('[data-account]')).to_have_count(0);assert abs(panel.bounding_box()['height']-original)<1
 # Android adjustResize can reduce the visible viewport to the keyboard's top edge.
 page.set_viewport_size({'width':width,'height':520});page.wait_for_timeout(200)
 assert search.bounding_box()['y']>=24, 'Search field is obscured after simulated keyboard resize'
 assert panel.bounding_box()['height']<=496.5
 reduced=panel.bounding_box()['height'];search.fill('虚构账户2');expect(panel.locator('[data-account]')).to_have_count(1);assert abs(panel.bounding_box()['height']-reduced)<1
 page.screenshot(path=str(OUT/f'keyboard-{label}.png'),animations='disabled')
 panel.locator('[data-account="2"]').click();page.locator('.entry-account-mask').wait_for(state='detached');page.set_viewport_size({'width':width,'height':height});expect(page.locator('#note')).to_have_value('虚构小米尺寸草稿');expect(page.locator('#amt')).to_have_text('8')
 page.locator('[data-cat-more]').click();expect(page.locator('#keypad')).to_be_hidden();expect(page.locator('#cat-jump')).to_be_visible()
 assert page.locator('#cat-jump input').count()==0
 # Choose a group and come back without changing category, amount, account or note.
 page.locator('[data-cat-jump]').last.click();page.locator('[data-cat-collapse]').click();expect(page.locator('#keypad')).to_be_visible();expect(page.locator('#amt')).to_have_text('8');expect(page.locator('#acct-name')).to_have_text('虚构账户2');expect(page.locator('#note')).to_have_value('虚构小米尺寸草稿')
 page.locator('#sheet-close').click();page.locator('[data-page="page-mine"]').click();page.get_by_role('button',name='应用设置',exact=True).click();settings=page.locator('#sp-settings');expect(settings.locator('#ai-thres')).to_be_attached();assert settings.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');assert not errors,errors;assert not external,external
 print('PASS Xiaomi14 browser simulation',label,flush=True)
if __name__=='__main__':
 OUT.mkdir(parents=True,exist_ok=True)
 with sync_playwright() as p:
  b=p.chromium.launch()
  for width,height,scale in [(400,890,1),(400,810,1),(393,873,1),(400,810,1.3)]:
   for theme in ['light','dark']:
    c=b.new_context(viewport={'width':width,'height':height},device_scale_factor=3,is_mobile=True,has_touch=True,service_workers='block',reduced_motion='reduce',locale='zh-CN',timezone_id='Asia/Shanghai');run(c.new_page(),width,height,scale,theme);c.close()
  b.close()
