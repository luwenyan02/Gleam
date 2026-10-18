"""Help entry, task guide, offline figures and back/focus behavior; fictional data only."""
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4602/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/help-manual'
TOPICS = ['开始使用', '记一笔', '账户与对账', '明细、退款与报销', '报表与预算', '分类、标签与周期账', '拾光与对话', '备份与恢复', 'AI 与短语音', '外观、安全与提醒', '版本与更新']

def run(page, width):
    errors, external = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(URL).netloc else (external.append(r.request.url), r.abort()))
    page.goto(URL); page.locator('#fab').wait_for()
    page.locator('[data-page="page-mine"]').click()
    help_group = page.locator('#page-mine section[aria-label="关于和帮助"]')
    button = help_group.get_by_role('button', name='使用手册', exact=False)
    expect(button).to_be_visible()
    button.click(); manual = page.locator('#sheet[aria-label="拾光使用手册"]')
    expect(manual).to_be_visible()
    expect(manual.locator('nav button')).to_have_count(len(TOPICS))
    for topic in TOPICS:
        manual.locator('nav').get_by_role('button', name=topic, exact=True).click()
        expect(manual.get_by_role('heading', name=topic, exact=True)).to_be_in_viewport()
    expect(manual).to_contain_text('我的 → 关于和帮助 → 使用手册')
    expect(manual).not_to_contain_text('我的 → 应用设置 → 关于拾光')
    for details in manual.locator('details').all():
        details.locator('summary').click()
    expect(manual.locator('.manual-figure')).to_have_count(9)
    for img in manual.locator('img').all():
        img.scroll_into_view_if_needed()
        expect(img).to_be_visible()
        img.evaluate('async i => { await i.decode(); if(i.naturalWidth !== 390 || i.naturalHeight !== 844) throw Error("Invalid screenshot"); }')
    zoom = manual.locator('[data-manual-zoom]').first
    zoom.scroll_into_view_if_needed(); zoom.press('Enter'); expect(zoom).to_have_attribute('aria-expanded', 'true')
    zoom.press('Space'); expect(zoom).to_have_attribute('aria-expanded', 'false')
    for theme in ['light', 'dark']:
        page.evaluate('(t)=>document.documentElement.dataset.theme=t', theme)
        manual.locator('.settings-manual').evaluate('e=>e.scrollTop=0')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        assert manual.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
        page.screenshot(path=str(OUT/f'manual-{width}-{theme}.png'),animations='disabled')
    manual.get_by_role('button', name='关闭使用手册').click(); expect(button).to_be_focused()
    button.click(); page.go_back(); expect(page.locator('#sheet.open')).to_have_count(0); expect(button).to_be_focused()
    help_group.locator('[data-about]').click(); expect(page.locator('#sheet .about-version')).to_contain_text('PWA')
    expect(page.locator('[data-update-check]')).to_have_count(0)
    page.get_by_role('button', name='关闭关于拾光').click()
    page.get_by_role('button',name='应用设置',exact=True).click()
    expect(page.locator('#sp-settings section[aria-label="关于"],#sp-settings [data-act="settings-manual"],#sp-settings [data-act="app-update"]')).to_have_count(0)
    assert not errors, errors
    assert not external, external

if __name__ == '__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width in (360,390,430,1280):
            context=browser.new_context(viewport={'width':width,'height':844},service_workers='block',reduced_motion='reduce')
            run(context.new_page(),width);context.close();print('PASS help/manual',width,flush=True)
        # Bundled help and all figures must work with the production PWA offline.
        context=browser.new_context(viewport={'width':390,'height':844},service_workers='allow',reduced_motion='reduce')
        page=context.new_page();page.goto(URL);page.locator('#fab').wait_for()
        page.evaluate('async()=>{await navigator.serviceWorker.ready}')
        page.wait_for_function('navigator.serviceWorker.controller !== null')
        context.set_offline(True);page.reload();page.locator('#fab').wait_for()
        page.locator('[data-page="page-mine"]').click();page.locator('[data-help-manual]').click()
        manual=page.locator('#sheet[aria-label="拾光使用手册"]')
        for details in manual.locator('.manual-pictures').all(): details.locator('summary').click()
        for img in manual.locator('img').all():
            img.scroll_into_view_if_needed();img.evaluate('async i=>{await i.decode();if(!i.naturalWidth)throw Error("Missing offline figure")}')
        context.close();print('PASS offline PWA guide and all 9 figures',flush=True)
        browser.close()
