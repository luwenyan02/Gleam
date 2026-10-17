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
    expect(settings.locator('[data-act="settings-manual"],section[aria-label="关于"]')).to_have_count(0)
    expect(settings.locator('p.tiny, details')).to_have_count(0)
    for text in ('可能产生费用', '使用与隐私说明', '预设核对于', '识别请求直连'):
        expect(settings).not_to_contain_text(text)
    expect(settings).to_contain_text('静默入账置信度阈值')
    expect(settings).to_contain_text('天后自动清除')
    initial = page.locator('#voice-bailian-workspace').input_value()
    operations = lambda: page.evaluate("window.__voiceCalls.filter(call=>['testCandidate','commitTestedKey','setKey','clearKey','testConnection','start','stop'].includes(call.method))")
    calls = operations()
    native_before = page.evaluate('window.__voiceSnapshot()')
    voice = settings.locator('section[aria-label="百炼短语音"]')
    expect(voice.locator('#voice-bailian-key')).to_have_accessible_name('语音Key')
    expect(voice.locator('#voice-bailian-key')).to_have_value('')
    expect(voice.locator('#voice-key-shared')).to_have_accessible_name('与 API Key 相同')
    expect(voice.locator('#voice-key-shared')).not_to_be_checked()
    expect(voice.locator('[data-voice-save-key], [data-voice-clear-key], [data-voice-key-status]')).to_have_count(0)
    expect(voice.locator('[data-voice-test]')).to_have_count(1)
    expect(voice.locator('[data-voice-test]')).to_have_text('测试语音连接')
    expect(voice.locator('[data-voice-test]')).to_have_attribute('data-state', 'idle')
    expect(voice.locator('[data-voice-test-consent], [data-voice-test-recipient], [data-voice-test-confirm], [data-voice-test-cancel], [data-voice-test-status], [data-voice-test-copy], [data-voice-test-copy-status]')).to_have_count(0)
    expect(voice.locator('#voice-bailian-model')).to_have_value('qwen3.8-omni-flash-realtime')
    expect(voice.locator('#voice-bailian-model')).to_have_attribute('readonly', '')
    expect(voice).not_to_contain_text('未测试')
    # The label and optional shared source remain in one discoverable, touch-sized row.
    label_row = voice.locator('.voice-key-label')
    assert label_row.evaluate('(el)=>el.scrollWidth<=el.clientWidth+1')
    labels = label_row.locator('label').evaluate_all('(els)=>els.map(el=>el.getBoundingClientRect().toJSON())')
    assert len(labels) == 2 and labels[0]['right'] <= labels[1]['left']
    assert abs((labels[0]['top'] + labels[0]['height']/2) - (labels[1]['top'] + labels[1]['height']/2)) < 1
    assert label_row.locator('label[for="voice-bailian-key"]').evaluate('(el)=>{const r=document.createRange();r.selectNodeContents(el);return r.getClientRects().length===1}')
    for section, name in (('安全', 'top'), ('AI 记账', 'ai'), ('百炼短语音', 'voice')):
        block = settings.locator(f'section[aria-label="{section}"]')
        block.scroll_into_view_if_needed()
        page.wait_for_timeout(220)
        assert_usable(page, f'#sp-settings section[aria-label="{section}"]')
        page.screenshot(path=str(OUT / f'{name}-{width}-{motion}.png'), animations='disabled')
    expect(page.locator('#voice-bailian-workspace')).to_have_value(initial)
    page.locator('#sp-settings .sub-head [data-act="back"]').click()
    manual_button = page.locator('#page-mine [data-help-manual]')
    manual_button.scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / f'about-{width}-{motion}.png'), animations='disabled')
    manual_button.click()
    manual = page.locator('#sheet[aria-label="拾光使用手册"]')
    expect(manual).to_be_visible()
    for text in ('可能产生服务商费用', '设置中的文字 AI 接口', '连接通过不代表录音和实际转写已测试', '关闭页面后不会在系统通知栏准时推送'):
        expect(manual).to_contain_text(text)
    expect(manual.locator('.manual-figure')).to_have_count(9)
    for details in manual.locator('details').all():
        details.locator('summary').click()
    for picture in manual.locator('.manual-figure img').all():
        picture.scroll_into_view_if_needed()
        expect(picture).to_be_visible()
        page.wait_for_function('(src)=>{const i=[...document.images].find(i=>i.getAttribute("src")===src);return i?.complete&&i.naturalWidth===390&&i.naturalHeight===844;}', arg=picture.get_attribute('src'))
    zoom = manual.locator('[data-manual-zoom]').first
    zoom.scroll_into_view_if_needed(); zoom.click()
    expect(zoom).to_have_attribute('aria-expanded', 'true')
    expect(zoom).to_have_accessible_name('缩小图解：找到使用手册')
    assert zoom.evaluate('(el)=>el.clientWidth<=Math.max(390,el.parentElement.clientWidth)+1')
    assert_usable(page, '#sheet')
    page.screenshot(path=str(OUT / f'manual-zoom-{width}-{motion}.png'), animations='disabled')
    zoom.press('Enter'); expect(zoom).to_have_attribute('aria-expanded', 'false')
    zoom.press('Space'); expect(zoom).to_have_attribute('aria-expanded', 'true')
    zoom.click(); expect(zoom).to_have_attribute('aria-expanded', 'false')
    manual.locator('.settings-manual').evaluate('(el)=>el.scrollTop=0')
    assert_usable(page, '#sheet')
    page.screenshot(path=str(OUT / f'manual-{width}-{motion}.png'), animations='disabled')
    manual.get_by_role('button', name='关闭使用手册').click()
    expect(page.locator('#sheet.open')).to_have_count(0)
    expect(manual_button).to_be_focused()
    manual_button.click(); page.go_back()
    expect(page.locator('#sheet.open')).to_have_count(0)
    expect(page.locator('#page-mine')).to_be_visible()
    settings_history = page.evaluate('history.state')
    page.go_forward()
    page.wait_for_function('(state)=>JSON.stringify(history.state)===JSON.stringify(state)', arg=settings_history)
    expect(page.locator('#sheet.open')).to_have_count(0)
    expect(page.locator('#page-mine')).to_be_visible()
    assert operations() == calls
    assert page.evaluate('window.__voiceSnapshot()') == native_before
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
                page = context.new_page()
                try:
                    run(page, width, motion)
                except Exception:
                    try:
                        page.screenshot(path=str(OUT / f'failure-{width}-{motion}.png'), animations='disabled')
                    except Exception:
                        print('Unable to capture the settings declutter failure screen', flush=True)
                    raise
                finally:
                    context.close()
            print(f'PASS compact settings {width}', flush=True)
        browser.close()
