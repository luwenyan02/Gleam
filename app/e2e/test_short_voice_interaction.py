"""Voice UI states and local-only consent preparation; synthetic bridge, no actual service/mic."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE, seed_config, open_entry_voice
from test_browser_usability import assert_usable
from test_life_ai import read_rows

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
    page.goto(URL); page.locator('#fab').wait_for(); seed_config(page)
    page.locator('#fab').click(); page.locator('#note').fill('语音之前的虚构草稿')
    page.locator('#btn-voice').click(); page.locator('[data-sv-text]').wait_for()
    activity = page.locator('[data-sv-activity]')
    count = lambda method: page.evaluate('(m)=>window.__voiceCalls.filter(x=>x.method===m).length', method)

    def capture(name):
        page.locator('#toast.show').wait_for(state='hidden')
        page.wait_for_timeout(220)
        assert_usable(page, '.short-voice-panel')
        page.screenshot(path=str(OUT / f'{name}-{width}-{motion}.png'), animations='disabled')

    expect(activity).to_be_hidden(); assert count('start') == 0 and not requests
    expect(page.locator('[data-sv-consent]')).to_have_count(0)
    expect(page.locator('.short-voice-editor-head button')).to_have_count(0)
    expect(page.locator('.short-voice-review-actions [data-sv-rerecord]')).to_have_count(1)
    expect(page.locator('.short-voice-review-actions [data-sv-send]')).to_have_count(1)
    expect(page.locator('[data-sv-rerecord]')).to_be_hidden()
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
    assert page.locator('.short-voice-editor-head label').evaluate('(el)=>{const range=document.createRange();range.selectNodeContents(el);return range.getClientRects().length===1;}')
    expect(page.locator('[data-sv-rerecord]')).to_be_visible()
    buttons = page.locator('.short-voice-review-actions button').evaluate_all('(els)=>els.map(el=>el.getBoundingClientRect().toJSON())')
    assert len(buttons) == 2
    assert abs(buttons[0]['top'] - buttons[1]['top']) < 1
    assert buttons[0]['right'] <= buttons[1]['left']
    assert all(button['width'] >= 44 and button['height'] >= 44 for button in buttons)
    assert not requests; capture('review')
    page.locator('[data-sv-text]').fill('修改后午餐25元现金')
    expect(page.locator('[data-sv-send-panel]')).to_be_hidden()
    expect(page.locator('[data-sv-send-panel]')).to_be_visible(); assert not requests

    # Re-record exposes a fresh consent first; cancel preserves earlier text.
    page.locator('[data-sv-rerecord]').click(); assert count('start') == 1
    expect(page.locator('[data-sv-voice-prompt]')).to_be_visible()
    expect(page.locator('[data-sv-rerecord]')).to_be_hidden()
    page.locator('[data-sv-start]').click(); expect(activity).to_be_visible()
    page.locator('[data-sv-cancel]').click(); expect(activity).to_be_hidden()
    expect(page.locator('[data-sv-text]')).to_have_value('修改后午餐25元现金')
    expect(page.locator('[data-sv-preview]')).to_be_visible()
    page.locator('[data-sv-preview]').click(); expect(page.locator('[data-sv-send-panel]')).to_be_visible()

    # Back dismisses only voice, cancels the native session, and never auto-restarts on Forward.
    page.locator('[data-sv-start]').click(); expect(activity).to_be_visible(); previous = count('cancel')
    page.go_back(); expect(page.locator('.short-voice-mask')).to_have_count(0)
    expect(page.locator('#keypad')).to_be_visible(); assert count('cancel') == previous + 1
    lower_layer = page.evaluate('history.state.gleamLayer')
    before = count('start'); page.go_forward(); assert count('start') == before
    expect(page.locator('.short-voice-mask')).to_have_count(0)
    page.wait_for_function('(id)=>history.state.gleamLayer===id', arg=lower_layer)
    expect(page.locator('#keypad')).to_be_visible()
    expect(page.locator('#note')).to_have_value('语音之前的虚构草稿')
    page.go_back(); expect(page.locator('#sheet.open')).to_have_count(0)
    assert count('start') == before
    open_entry_voice(page); expect(page.locator('[data-sv-start]')).to_be_enabled()
    page.evaluate("window.__voiceError='SPEECH_PERMISSION_DENIED'")
    page.locator('[data-sv-start]').click()
    expect(page.locator('[data-sv-status]')).to_contain_text('麦克风未获授权')
    expect(activity).to_be_hidden(); capture('permission-error')
    page.keyboard.press('Escape'); expect(page.locator('.short-voice-mask')).to_have_count(0)
    expect(page.locator('#btn-voice')).to_be_focused()
    assert not errors, errors
    assert not requests, requests
    assert page.evaluate('window.__micCalls') == 0


def run_result_actions(page, width, motion):
    errors, requests, payloads = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(MOCK)
    page.route('https://**/*', lambda route: route.abort())

    def model(route):
        payloads.append(route.request.post_data_json)
        route.fulfill(json={'choices': [{'message': {'content': '[{"type":"expense","amount":"28.01","category":"餐饮/午餐","account":"现金","time":"2026-10-03 12:00","note":"虚构午餐","confidence":100}]'}}]})

    page.route('https://short-voice.invalid/**', model)
    page.on('request', lambda request: requests.append(request.url) if request.url.startswith('https://') else None)
    page.goto(URL); page.locator('#fab').wait_for(); seed_config(page)
    page.locator('#fab').click(); page.locator('#note').fill('保留的虚构记账草稿')
    page.locator('#note').blur(); page.locator('#btn-voice').click()
    count = lambda method: page.evaluate('(method)=>window.__voiceCalls.filter(call=>call.method===method).length', method)

    def remember_button():
        page.evaluate("window.__resultRerecord=document.querySelector('[data-sv-rerecord]')")

    def recognize(text):
        before = len(payloads)
        page.locator('[data-sv-text]').fill(text)
        expect(page.locator('[data-sv-send-panel]')).to_be_visible()
        assert len(payloads) == before
        page.locator('[data-sv-send]').click()
        expect(page.locator('[data-sv-result]')).to_be_visible()
        expect(page.locator('[data-sv-apply]')).to_be_enabled()
        assert len(payloads) == before + 1

    def check_result(name, label):
        expect(page.locator('[data-sv-status]')).to_have_text('识别完成，尚未入账')
        expect(page.locator('[data-sv-apply]')).to_have_text(label)
        expect(page.locator('[data-sv-rerecord]')).to_have_count(1)
        expect(page.locator('[data-sv-result-actions] > [data-sv-rerecord]')).to_be_visible()
        expect(page.locator('[data-sv-review-actions]')).to_be_hidden()
        assert page.evaluate("document.querySelector('[data-sv-rerecord]')===window.__resultRerecord")
        page.locator('[data-sv-result-actions]').scroll_into_view_if_needed()
        page.locator('#toast.show').wait_for(state='hidden'); page.wait_for_timeout(220)
        assert_usable(page, '.short-voice-panel')
        bounds = page.locator('[data-sv-result-actions]').evaluate('''row => ({
          row: row.getBoundingClientRect().toJSON(),
          buttons: [...row.children].map(button => ({...button.getBoundingClientRect().toJSON(),
            overflow: button.scrollWidth > button.clientWidth + 1})),
        })''')
        left, right = bounds['buttons']
        assert abs(left['top'] - right['top']) < 1 and abs(left['bottom'] - right['bottom']) < 1
        assert left['right'] <= right['left'] and left['left'] >= bounds['row']['left'] - 1
        assert right['right'] <= bounds['row']['right'] + 1
        assert all(button['width'] >= 44 and button['height'] >= 44 and not button['overflow'] for button in (left, right))
        assert not read_rows(page, 'entries')
        page.screenshot(path=str(OUT / f'{name}-{width}-{motion}.png'), animations='disabled')

    remember_button(); recognize('虚构午餐28.01元现金')
    check_result('result-entry', '填入当前草稿')
    page.locator('[data-sv-rerecord]').focus(); page.keyboard.press('Tab')
    expect(page.locator('[data-sv-apply]')).to_be_focused()
    page.keyboard.press('Shift+Tab'); expect(page.locator('[data-sv-rerecord]')).to_be_focused()
    assert count('start') == 0
    # A future longer caller label must not collapse or overlap the shared footer.
    long_label = '将这笔已经核对完成的语音记录填入当前草稿'
    page.locator('[data-sv-apply]').evaluate('(button,label)=>button.textContent=label', long_label)
    check_result('result-entry-long-label', long_label)
    page.locator('[data-sv-apply]').evaluate("button=>button.textContent='填入当前草稿'")

    # Editing invalidates the final draft and moves the original button back beside Send.
    page.locator('[data-sv-text]').fill('修改后虚构午餐28.01元现金')
    expect(page.locator('[data-sv-result]')).to_be_hidden()
    expect(page.locator('[data-sv-review-actions] > [data-sv-rerecord]')).to_be_visible()
    expect(page.locator('[data-sv-apply]')).to_be_disabled()
    expect(page.locator('[data-sv-send-panel]')).to_be_visible(); assert len(payloads) == 1
    page.locator('[data-sv-send]').click(); expect(page.locator('[data-sv-apply]')).to_be_enabled()
    expect(page.locator('[data-sv-result-actions] > [data-sv-rerecord]')).to_be_visible()
    assert len(payloads) == 2

    # The moved button retains its listener; a click alone never captures or resends.
    page.locator('[data-sv-rerecord]').click()
    expect(page.locator('[data-sv-start]')).to_be_focused()
    expect(page.locator('[data-sv-result]')).to_be_visible()
    expect(page.locator('[data-sv-rerecord]')).to_be_hidden()
    assert count('start') == 0 and len(payloads) == 2
    page.locator('[data-sv-start]').click()
    expect(page.locator('[data-sv-result]')).to_be_hidden()
    page.wait_for_function('window.__voicePending.size===1')
    session = page.evaluate("window.__voiceCalls.filter(call=>call.method==='start').at(-1).sessionId")
    page.locator('[data-sv-cancel]').click()
    page.evaluate("id=>window.__voicePending.get(id).resolve({sessionId:id,text:'取消后的迟到文字'})", session)
    expect(page.locator('[data-sv-text]')).to_have_value('修改后虚构午餐28.01元现金')
    expect(page.locator('[data-sv-result]')).to_be_hidden()
    page.locator('[data-sv-preview]').click(); expect(page.locator('[data-sv-send-panel]')).to_be_visible()
    page.locator('[data-sv-send]').click(); expect(page.locator('[data-sv-result]')).to_be_visible()
    assert len(payloads) == 3

    # Back/Forward from the final result still preserves the underlying entry draft.
    page.go_back(); expect(page.locator('.short-voice-mask')).to_have_count(0)
    expect(page.locator('#note')).to_have_value('保留的虚构记账草稿')
    expect(page.locator('#btn-voice')).to_be_focused()
    lower_layer = page.evaluate('history.state.gleamLayer')
    page.go_forward(); expect(page.locator('.short-voice-mask')).to_have_count(0)
    page.wait_for_function('(id)=>history.state.gleamLayer===id', arg=lower_layer)
    assert count('start') == 1 and len(payloads) == 3
    page.locator('#btn-voice').click(); remember_button(); recognize('再次虚构午餐28.01元现金')
    page.locator('[data-sv-apply]').click(); expect(page.locator('.short-voice-mask')).to_have_count(0)
    expect(page.locator('#amt')).to_have_text('28.01'); expect(page.locator('#note')).to_have_value('虚构午餐')
    assert not read_rows(page, 'entries')
    page.locator('#sheet-close').click()

    # The inbox caller uses the identical footer with its own longer Apply label.
    page.locator('[data-qa="ai"]').click(); page.locator('#ai-text').fill('保留的虚构收件箱草稿')
    page.locator('[data-act="short-voice"]').click(); remember_button(); recognize('收件箱虚构午餐28.01元现金')
    check_result('result-inbox', '加入收件箱待确认')
    page.locator('[data-sv-apply]').click(); expect(page.locator('.short-voice-mask')).to_have_count(0)
    expect(page.locator('#ai-text')).to_have_value('保留的虚构收件箱草稿')
    queue = next(row['value'] for row in read_rows(page, 'settings') if row['key'] == 'ai.pendingItems')
    assert len(queue) == 1 and queue[0]['source'] == 'voice' and queue[0]['status'] == 'ready'
    assert not read_rows(page, 'entries')
    assert count('start') == 1 and len(payloads) == 5
    assert page.evaluate('window.__micCalls') == 0
    assert all(url.startswith('https://short-voice.invalid/') for url in requests), requests
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1280):
            for motion in ('reduce', 'no-preference'):
                context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block', reduced_motion=motion)
                run(context.new_page(), width, motion); context.close()
                context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block', reduced_motion=motion)
                run_result_actions(context.new_page(), width, motion); context.close()
            print(f'PASS voice interaction {width}', flush=True)
        browser.close()
