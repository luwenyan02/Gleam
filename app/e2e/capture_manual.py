"""Capture unedited 390px manual images with fictional data and a simulated voice bridge.

Run against a production preview after UI changes. Review .tmp images before copying
into public/manual. No real microphone, service credentials or network calls.
"""
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from capture_readme import seed, DEMO_TIME
from test_short_voice import MOCK_NATIVE, seed_config, open_voice_advanced

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4602/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/manual'

def capture(page, name, selector):
    page.locator(selector).wait_for()
    page.locator('#toast.show').wait_for(state='hidden')
    page.evaluate('''() => { document.activeElement?.blur(); for (const i of document.querySelectorAll('input[type=text],input:not([type]),textarea')) { try {i.setSelectionRange(0,0);} catch {} } window.getSelection()?.removeAllRanges(); }''')
    page.wait_for_timeout(250)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(OUT/f'{name}.png'),animations='disabled')

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    errors, blocked = [], []
    with sync_playwright() as p:
        browser=p.chromium.launch()
        def context():
            ctx=browser.new_context(viewport={'width':390,'height':844},locale='zh-CN',timezone_id='Asia/Shanghai',service_workers='block',reduced_motion='reduce')
            ctx.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc==urlsplit(URL).netloc else (blocked.append(r.request.url),r.abort()))
            page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.clock.set_fixed_time(DEMO_TIME)
            return ctx,page
        ctx,page=context();page.goto(URL);page.locator('#fab').wait_for();seed(page)
        page.locator('#fab').click();page.locator('#note').fill('午餐');page.locator('#note').blur()
        page.locator('[data-k="3"]').click();page.locator('[data-k="2"]').click()
        capture(page,'entry','#keypad')
        page.locator('#acct-btn').click();capture(page,'account-picker','.entry-account-picker')
        page.locator('.entry-account-picker [data-account]').first.click();page.locator('#sheet-close').click()
        page.locator('[data-page="page-report"]').click();page.locator('#report-dim [data-dimension="account"]').click();page.locator('#rank .rank-link').first.wait_for();capture(page,'report','#page-report')
        page.locator('[data-page="page-mine"]').click();page.locator('[data-sub="sp-backup"]').click();page.locator('#sp-backup [data-act="backup"]').wait_for();capture(page,'backup','#sp-backup')
        page.locator('#sp-backup .sub-head [data-act="back"]').click();page.locator('#page-mine section[aria-label="关于和帮助"]').scroll_into_view_if_needed();capture(page,'manual-entry','#page-mine [data-help-manual]');ctx.close()
        ctx,page=context();page.add_init_script(MOCK_NATIVE);page.goto(URL);page.locator('#fab').wait_for();seed_config(page)
        page.locator('[data-page="page-mine"]').click()
        page.locator('#page-mine [data-sub="sp-ai-settings"]').click()
        page.locator('#voice-bailian-key').fill('fictional-demo-voice-key');open_voice_advanced(page);page.locator('#voice-bailian-workspace').fill('');page.locator('#voice-bailian-workspace').press('Tab');page.locator('[data-voice-test]').click();expect(page.locator('[data-voice-test]')).to_have_attribute('data-state','success')
        page.locator('[data-settings-detail="voice-advanced"] > summary').click()
        page.locator('#sp-ai-settings section[aria-label="百炼短语音"]').evaluate('e=>e.scrollIntoView({block:"start"})');capture(page,'voice-settings','#voice-bailian-key')
        page.locator('#sp-ai-settings .sub-head [data-act="back"]').click();page.locator('#tab-home').click();page.locator('[data-qa="ai"]').click();page.locator('[data-act="short-voice"]').click();capture(page,'voice-start','[data-hv-hold]')
        button=page.locator('[data-hv-hold]').bounding_box();page.mouse.move(button['x']+button['width']/2,button['y']+button['height']/2);page.mouse.down()
        expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','listening');capture(page,'voice-listening','[data-hv-status]')
        edit=page.locator('[data-hv-zone="edit"]').bounding_box();page.mouse.move(edit['x']+edit['width']/2,edit['y']+edit['height']/2);page.mouse.up()
        page.locator('[data-hv-text]').fill('今天午餐28元，现金');page.locator('[data-hv-text]').blur();capture(page,'voice-review','[data-hv-send]')
        assert page.evaluate('window.__micCalls')==0
        ctx.close();browser.close()
    assert not errors,errors
    assert not blocked,blocked
    (OUT/'hashes.json').write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.glob('*.png'))},indent=2))
    print('PASS 9 synthetic screenshots; no external requests or microphone use',flush=True)

if __name__=='__main__':main()
