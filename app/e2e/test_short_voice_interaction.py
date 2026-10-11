"""Voice UI states and local-only consent preparation; synthetic bridge, no actual service/mic."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE, seed_config, open_entry_voice
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/short-voice-interaction'
MOCK = MOCK_NATIVE.replace(
    "window.__voiceListeners.forEach(callback => callback({sessionId:options.sessionId,state:'listening'}));",
    "if (!window.__holdListening) window.__voiceListeners.forEach(callback => callback({sessionId:options.sessionId,state:'listening'}));"
).replace("window.__voicePending.get(options.sessionId)?.resolve", "if (!window.__holdTranscript) window.__voicePending.get(options.sessionId)?.resolve")
MOCK += ';window.__voiceHasKey=true;window.__holdListening=true;window.__holdTranscript=true;'


def run(page, width, motion):
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(MOCK)
    page.route('https://**/*', lambda route: route.abort())
    page.on('request', lambda req: requests.append(req.url) if req.url.startswith('https://') else None)
    page.goto(URL); page.locator('#fab').wait_for(); seed_config(page); open_entry_voice(page)
    activity = page.locator('[data-sv-activity]')
    count = lambda method: page.evaluate('(m)=>window.__voiceCalls.filter(x=>x.method===m).length', method)

    def capture(name):
        page.locator('#toast.show').wait_for(state='hidden')
        assert_usable(page, '.short-voice-panel')
        page.screenshot(path=str(OUT / f'{name}-{width}-{motion}.png'), animations='disabled')

    expect(activity).to_be_hidden(); assert count('start') == 0 and not requests
    expect(page.locator('[data-sv-consent]')).to_contain_text('费用')
    capture('ready')
    page.locator('[data-sv-start]').click()
    expect(activity).to_have_attribute('data-state', 'connecting'); expect(activity).to_be_visible()
    expect(page.locator('[data-sv-status]')).not_to_contain_text('正在听')
    expect(page.locator('[data-sv-stop]')).to_be_hidden()
    expect(page.locator('[data-sv-editor]')).to_be_hidden()
    expect(page.locator('[data-sv-cancel]')).to_be_focused()
    page.locator('[data-sv-start]').dispatch_event('click'); assert count('start') == 1
    capture('connecting')
    page.wait_for_function("window.__voicePending.size===1")
    current = page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').at(-1).sessionId")
    page.evaluate("id=>window.__voiceListeners.forEach(cb=>cb({sessionId:id,state:'listening'}))", current)
    expect(activity).to_have_attribute('data-state', 'listening')
    expect(page.locator('[data-sv-stop]')).to_be_visible()
    animations = page.locator('.short-voice-bars i').evaluate_all('(els)=>els.map(el=>getComputedStyle(el).animationName)')
    assert all(name == 'none' for name in animations) if motion == 'reduce' else any(name == 'short-voice-bar' for name in animations)
    capture('listening')
    page.locator('[data-sv-stop]').click(); expect(activity).to_have_attribute('data-state', 'transcribing')
    expect(page.locator('[data-sv-stop]')).to_be_hidden(); capture('transcribing')
    page.evaluate("id=>window.__voicePending.get(id).resolve({sessionId:id,text:'虚构午餐28元现金'})", current)
    expect(activity).to_be_hidden(); expect(page.locator('[data-sv-send-panel]')).to_be_visible()
    expect(page.locator('[data-sv-voice-prompt]')).to_be_hidden()
    expect(page.locator('[data-sv-preview]')).to_be_hidden()
    assert not requests; capture('review')
    page.locator('[data-sv-text]').fill('修改后午餐25元现金')
    expect(page.locator('[data-sv-send-panel]')).to_be_hidden()
    expect(page.locator('[data-sv-send-panel]')).to_be_visible(); assert not requests

    # Re-record exposes a fresh consent first; cancel preserves earlier text.
    page.locator('[data-sv-rerecord]').click(); assert count('start') == 1
    expect(page.locator('[data-sv-voice-prompt]')).to_be_visible()
    page.locator('[data-sv-start]').click(); expect(activity).to_be_visible()
    page.locator('[data-sv-cancel]').click(); expect(activity).to_be_hidden()
    expect(page.locator('[data-sv-text]')).to_have_value('修改后午餐25元现金')
    expect(page.locator('[data-sv-preview]')).to_be_visible()
    page.locator('[data-sv-preview]').click(); expect(page.locator('[data-sv-send-panel]')).to_be_visible()

    # Back dismisses only voice, cancels the native session, and never auto-restarts on Forward.
    page.locator('[data-sv-start]').click(); expect(activity).to_be_visible(); previous = count('cancel')
    page.go_back(); expect(page.locator('.short-voice-mask')).to_have_count(0)
    expect(page.locator('#keypad')).to_be_visible(); assert count('cancel') == previous + 1
    before = count('start'); page.go_forward(); assert count('start') == before
    expect(page.locator('.short-voice-mask')).to_have_count(0)
    page.locator('#btn-voice').click(); expect(page.locator('[data-sv-start]')).to_be_enabled()
    page.evaluate("window.__voiceError='SPEECH_PERMISSION_DENIED'")
    page.locator('[data-sv-start]').click()
    expect(page.locator('[data-sv-status]')).to_contain_text('麦克风未获授权')
    expect(activity).to_be_hidden(); capture('permission-error')
    page.keyboard.press('Escape'); expect(page.locator('.short-voice-mask')).to_have_count(0)
    expect(page.locator('#btn-voice')).to_be_focused()
    assert not errors, errors
    assert not requests, requests
    assert page.evaluate('window.__micCalls') == 0


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1280):
            for motion in ('reduce', 'no-preference'):
                context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block', reduced_motion=motion)
                run(context.new_page(), width, motion); context.close()
            print(f'PASS voice interaction {width}', flush=True)
        browser.close()
