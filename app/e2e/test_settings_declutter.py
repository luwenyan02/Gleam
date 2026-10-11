"""Compact settings and local manual, with synthetic native bridge and blocked services."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE, seed_config
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/settings-declutter'


def run(page, width, motion):
    errors, requests = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(MOCK_NATIVE)
    page.route('https://**/*', lambda route: route.abort())
    page.on('request', lambda req: requests.append(req.url) if req.url.startswith('https://') else None)
    page.goto(URL); page.locator('#fab').wait_for(); seed_config(page)
    page.locator('[data-page="page-mine"]').click()
    page.get_by_role('button', name='应用设置', exact=True).click()
    settings = page.locator('#sp-settings')
    expect(settings.locator('[data-act="settings-manual"]')).to_be_visible()
    expect(settings.locator('p.tiny, details')).to_have_count(0)
    for text in ('可能产生费用', '使用与隐私说明', '预设核对于', '识别请求直连'):
        expect(settings).not_to_contain_text(text)
    expect(settings).to_contain_text('静默入账置信度阈值')
    expect(settings).to_contain_text('天后自动清除')
    initial = page.locator('#voice-bailian-workspace').input_value()
    calls = page.evaluate('window.__voiceCalls.length')
    for section, name in (('安全', 'top'), ('AI 记账', 'ai'), ('百炼短语音', 'voice')):
        block = settings.locator(f'section[aria-label="{section}"]')
        block.scroll_into_view_if_needed()
        assert_usable(page, f'#sp-settings section[aria-label="{section}"]')
        page.screenshot(path=str(OUT / f'{name}-{width}-{motion}.png'), animations='disabled')
    manual_button = settings.locator('[data-act="settings-manual"]')
    manual_button.scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / f'about-{width}-{motion}.png'), animations='disabled')
    manual_button.click()
    manual = page.locator('#sheet[aria-label="拾光使用手册"]')
    expect(manual).to_be_visible()
    for text in ('可能产生服务商费用', '设置中的文字 AI 接口', '连接通过不代表录音和实际转写已测试', '关闭页面后不会在系统通知栏准时推送'):
        expect(manual).to_contain_text(text)
    assert_usable(page, '#sheet')
    page.screenshot(path=str(OUT / f'manual-{width}-{motion}.png'), animations='disabled')
    manual.get_by_role('button', name='关闭使用手册').click()
    expect(page.locator('#sheet.open')).to_have_count(0)
    expect(manual_button).to_be_focused()
    manual_button.click(); page.go_back()
    expect(page.locator('#sheet.open')).to_have_count(0)
    expect(settings).to_be_visible()
    settings_history = page.evaluate('history.state')
    page.go_forward()
    page.wait_for_function('(state)=>JSON.stringify(history.state)===JSON.stringify(state)', arg=settings_history)
    expect(page.locator('#sheet.open')).to_have_count(0)
    expect(settings).to_be_visible()
    expect(page.locator('#voice-bailian-workspace')).to_have_value(initial)
    assert page.evaluate('window.__voiceCalls.length') == calls
    assert page.evaluate('window.__micCalls') == 0
    assert not requests, requests
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1280):
            for motion in ('reduce', 'no-preference'):
                context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block', reduced_motion=motion)
                run(context.new_page(), width, motion); context.close()
            print(f'PASS compact settings {width}', flush=True)
        browser.close()
