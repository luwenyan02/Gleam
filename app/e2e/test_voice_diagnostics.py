"""Synthetic native candidate transactions only; never test a real Key, microphone or provider."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE, seed_config, open_voice_advanced
from test_browser_usability import assert_usable
from test_life_ai import read_rows

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/voice-diagnostics'
BASE_KEY = 'fixture-voice-original-12345'
DRAFT_KEY = 'draft-voice-replacement-67890'
MAIN_KEY = 'changed-main-native-only-abcde'
DEFAULT_MODEL = 'qwen3.8-omni-flash-realtime'
LONG_REASONS = [
    'ACK_SESSION_MISSING', 'ACK_SESSION_NULL', 'ACK_SESSION_TYPE', 'ACK_MODEL_TYPE',
    'ACK_MODEL_MISMATCH', 'ACK_TURN_DETECTION_MISSING', 'ACK_TURN_DETECTION_TYPE',
    'ACK_TURN_DETECTION_MISMATCH', 'ACK_MODALITIES_MISSING', 'ACK_MODALITIES_TYPE',
    'ACK_MODALITIES_MISMATCH', 'ACK_TRANSCRIPTION_MISSING', 'ACK_TRANSCRIPTION_TYPE',
    'ACK_TRANSCRIPTION_MODEL_MISSING', 'ACK_TRANSCRIPTION_MODEL_TYPE',
    'ACK_TRANSCRIPTION_MODEL_MISMATCH', 'ACK_AUDIO_MISSING', 'ACK_AUDIO_TYPE',
    'ACK_AUDIO_INPUT_MISSING', 'ACK_AUDIO_INPUT_TYPE', 'ACK_AUDIO_FORMAT_MISSING',
    'ACK_AUDIO_FORMAT_TYPE', 'ACK_AUDIO_ENCODING_MISSING', 'ACK_AUDIO_ENCODING_TYPE',
]
MOCK = MOCK_NATIVE + r""";(() => {
  window.__copiedDiagnostics = [];
  Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => {window.__copiedDiagnostics.push(text);}}});
})()"""


def summary(value):
    return f'{value[:5]}••••••{value[-5:]}' if len(value) > 15 else '••••••'


def run(page, width, motion):
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(MOCK)
    page.route('https://**/*', lambda route: route.abort())
    page.on('request', lambda req: requests.append(req.url) if req.url.startswith('https://') else None)
    page.goto(URL); page.locator('#fab').wait_for(); seed_config(page)
    page.locator('[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-ai-settings"]').click()
    key = page.locator('#voice-bailian-key')
    shared = page.locator('#voice-key-shared')
    button = page.locator('[data-voice-test]')
    toast = page.locator('#toast')
    count = lambda method: page.evaluate('(m)=>window.__voiceCalls.filter(x=>x.method===m).length', method)
    snapshot = lambda: page.evaluate('window.__voiceSnapshot()')

    def compact_controls():
        expect(button).to_have_count(1)
        expect(page.locator('[data-voice-test-consent], [data-voice-test-recipient], [data-voice-test-confirm], [data-voice-test-cancel], [data-voice-test-status], [data-voice-test-copy], [data-voice-test-copy-status]')).to_have_count(0)

    def capture(name, result=False):
        page.locator('[aria-label="百炼短语音"]').scroll_into_view_if_needed()
        if result:
            expect(toast).to_have_class('show')
        else:
            page.locator('#toast.show').wait_for(state='hidden')
        page.wait_for_timeout(220)
        compact_controls()
        assert_usable(page, '[aria-label="百炼短语音"]')
        page.screenshot(path=str(OUT / f'{name}-{width}-{motion}.png'), animations='disabled')

    def start():
        compact_controls()
        expect(button).to_have_text('测试语音连接')
        expect(button).to_be_enabled()
        button.click()
        compact_controls()

    def busy(state='testing'):
        expect(button).to_have_attribute('data-state', state)
        expect(button).to_have_text('取消测试')
        expect(button).to_be_enabled()

    def succeeded():
        expect(button).to_have_attribute('data-state', 'success')
        expect(button).to_have_text('测试语音连接')
        expect(toast).to_have_class('show')
        expect(toast).to_contain_text('连接通过')
        expect(toast).to_contain_text('录音未测试')
        compact_controls()

    def set_region(name):
        open_voice_advanced(page)
        value = {'北京': 'beijing', '新加坡': 'singapore'}[name]
        region = page.locator('#voice-bailian-region')
        previous = region.get_attribute('data-region')
        region.click()
        picker = page.locator('.picker-mask[aria-label="百炼语音地域"]')
        expect(picker).to_be_visible()
        # The selected option contains a visible checkmark in its accessible name. Use its
        # exact value inside this picker, and assert both label and selection state, so this
        # also covers deliberately choosing the current region again.
        option = picker.locator(f'[role="option"][data-value="{value}"]')
        expect(option.locator('.picker-item-label')).to_have_text(name)
        expect(option).to_have_attribute('aria-selected', str(previous == value).lower())
        option.click()
        picker.wait_for(state='detached')
        expect(region).to_have_attribute('data-region', value)
        expect(region).to_have_text(name)

    def assert_original():
        current = snapshot()
        # Native credential revisions may rotate after a main-key edit; the working independent
        # key and its atomic destination must still be unchanged by rejected voice transactions.
        for field in ('hasKey', 'keySource', 'maskedKey', 'activeConfig'):
            assert current[field] == original[field], (field, current)
        assert page.evaluate('window.__voiceCommitCount') == 1

    expect(key).to_have_value('')
    expect(key).to_have_accessible_name('语音Key')
    expect(shared).not_to_be_checked()
    expect(button).to_be_disabled()
    open_voice_advanced(page)
    expect(page.locator('[data-voice-save-key], [data-voice-clear-key], [data-voice-key-status]')).to_have_count(0)
    key.fill(BASE_KEY); key.press('Tab')
    page.locator('#voice-bailian-workspace').fill('verified-workspace')
    page.locator('#voice-bailian-workspace').press('Tab')
    set_region('新加坡')
    expect(page.locator('#voice-bailian-model')).to_have_value(DEFAULT_MODEL)
    expect(page.locator('#voice-bailian-model')).to_have_attribute('readonly', '')
    compact_controls()
    assert snapshot()['hasKey'] is False
    assert count('testCandidate') == count('commitTestedKey') == count('start') == 0
    rows = read_rows(page, 'settings')
    assert next(row['value'] for row in rows if row['key'] == 'voice.bailian.workspace') == 'synthetic-workspace'
    assert not any(row['key'] == 'voice.bailian.region' and row['value'] == 'singapore' for row in rows)

    # The first click authorizes this candidate. A second click during local preflight
    # cancels it; late readiness must not start any provider operation or commit.
    page.evaluate('window.__holdNextConfiguration=true;window.__finishConfiguration=null')
    start(); busy('preparing')
    page.wait_for_function("typeof window.__finishConfiguration==='function'")
    assert count('testCandidate') == count('commitTestedKey') == 0
    capture('preparing')
    button.click()
    expect(button).to_have_attribute('data-state', 'idle')
    expect(button).to_have_text('测试语音连接')
    page.evaluate('window.__finishConfiguration()')
    assert count('testCandidate') == count('commitTestedKey') == 0
    assert snapshot()['hasKey'] is False

    # Neither staging nor an in-flight candidate changes the active credentials/destination.
    page.evaluate('window.__holdTest=true')
    start()
    busy()
    page.wait_for_function("typeof window.__finishTest==='function'")
    assert count('testCandidate') == 1 and count('commitTestedKey') == 0
    assert snapshot()['hasKey'] is False
    # An unrelated settings refresh preserves the active transaction and the same
    # cancel-capable control; it cannot write the pending candidate or restore an old success.
    page.evaluate('''() => {
      window.__oldVoiceInput=document.querySelector('#voice-bailian-key');
      const threshold=document.querySelector('#ai-thres');threshold.value='90';
      threshold.dispatchEvent(new Event('change',{bubbles:true}));
    }''')
    page.wait_for_function("document.querySelector('#voice-bailian-key')!==window.__oldVoiceInput")
    busy()
    assert count('testCandidate') == 1 and count('commitTestedKey') == 0
    assert snapshot()['hasKey'] is False
    capture('testing')
    page.evaluate('window.__holdTest=false;window.__finishTest()')
    succeeded()
    capture('success', result=True)
    expect(key).to_have_value(''); expect(key).to_have_attribute('placeholder', summary(BASE_KEY))
    assert count('testCandidate') == count('commitTestedKey') == 1
    original = snapshot()
    assert original['keySource'] == 'separate' and original['maskedKey'] == summary(BASE_KEY)
    assert original['activeConfig'] == {'region': 'singapore', 'workspace': 'verified-workspace', 'model': 'qwen3.8-omni-flash-realtime'}
    first = page.evaluate("window.__voiceCalls.find(x=>x.method==='testCandidate')")
    assert first['hasValue'] and first['consent'] and first['userInitiated']
    assert first['expectedMainCredentialRevision'] == original['mainCredentialRevision']
    assert first['expectedCredentialRevision'] != original['credentialRevision']
    assert first['configurationId'] and count('start') == 0

    # Editing does not save. Failure feedback stays in the existing toast, contains
    # only bounded diagnostic codes, and never copies anything to the clipboard.
    key.fill(DRAFT_KEY)
    expect(button).not_to_have_attribute('data-state', 'success')
    assert_original()
    page.evaluate("window.__testError='SPEECH_PROTOCOL'")
    start()
    expect(button).to_have_attribute('data-state', 'error')
    for text in ('SPEECH_PROTOCOL', '阶段：确认配置'):
        expect(toast).to_contain_text(text)
    expect(toast).not_to_contain_text('；原因：')
    for reason in ('ACK_MODEL_MISMATCH', 'ACK_AUDIO_FORMAT_MISSING'):
        assert f'[{reason}]' in (button.get_attribute('title') or '')
        expect(toast).not_to_contain_text(reason)
    for text in ('PRIVATE_PROVIDER_BODY', 'PRIVATE_UNKNOWN_REASON'):
        expect(toast).not_to_contain_text(text)
    assert count('commitTestedKey') == 1
    assert_original()
    assert page.evaluate('window.__copiedDiagnostics.length') == 0
    diagnostic = toast.inner_text() + (button.get_attribute('title') or '')
    assert not any(secret in diagnostic for secret in ['PRIVATE_PROVIDER_BODY', 'PRIVATE_UNKNOWN_REASON', 'verified-workspace', BASE_KEY, DRAFT_KEY])
    expect(button).to_have_text('测试语音连接')
    compact_controls()
    capture('error', result=True)

    # All 24 safe reason codes remain inspectable without turning the toast into a
    # viewport-sized diagnostic panel. Every viewport/motion run captures this case.
    assert len(LONG_REASONS) == len(set(LONG_REASONS)) == 24
    page.evaluate('(reasons)=>window.__testReasons=[...reasons,"PRIVATE_UNKNOWN_REASON"]', LONG_REASONS)
    key.fill(DRAFT_KEY); start()
    expect(button).to_have_attribute('data-state', 'error')
    expect(toast).to_have_class('show')
    expect(toast).to_contain_text('SPEECH_PROTOCOL')
    expect(toast).to_contain_text('阶段：确认配置')
    expect(toast).not_to_contain_text('；原因：')
    title = button.get_attribute('title') or ''
    for reason in LONG_REASONS:
        assert f'[{reason}]' in title, (reason, title)
        expect(toast).not_to_contain_text(reason)
    assert title.count('[ACK_') == 24
    assert not any(secret in title + toast.inner_text() for secret in ['PRIVATE_PROVIDER_BODY', 'PRIVATE_UNKNOWN_REASON', 'verified-workspace', BASE_KEY, DRAFT_KEY])
    assert page.evaluate('window.__copiedDiagnostics.length') == 0
    assert_original()
    compact_controls()
    page.mouse.move(0, 0)
    page.wait_for_timeout(260)
    bounds, viewport = toast.bounding_box(), page.viewport_size
    assert bounds is not None and viewport is not None
    assert bounds['x'] >= 0 and bounds['y'] >= 0, bounds
    assert bounds['x'] + bounds['width'] <= viewport['width'] + 1, (bounds, viewport)
    assert bounds['y'] + bounds['height'] <= viewport['height'] + 1, (bounds, viewport)
    assert bounds['height'] <= viewport['height'] / 4, (bounds, viewport)
    assert toast.evaluate('(el)=>el.scrollWidth<=el.clientWidth+1')
    capture('error-long', result=True)
    page.evaluate('window.__testReasons=null')

    # A provider success still cannot count as success if native durable storage fails.
    page.evaluate("window.__testError=null;window.__commitError='SPEECH_KEY_STORAGE'")
    key.fill(DRAFT_KEY); start()
    expect(button).to_have_attribute('data-state', 'error')
    expect(toast).to_contain_text('SPEECH_KEY_STORAGE')
    assert_original()
    page.evaluate('window.__commitError=null;window.__holdTest=true;window.__finishTest=null')

    # A main-key edit during local preflight invalidates the clicked candidate before
    # any provider test begins, even if its earlier native readiness arrives late.
    key.fill(DRAFT_KEY)
    page.evaluate('window.__holdNextConfiguration=true;window.__finishConfiguration=null')
    before = count('testCandidate')
    start(); busy('preparing')
    page.wait_for_function("typeof window.__finishConfiguration==='function'")
    page.locator('#ai-key').fill('preflight-replaced-main-key-uvwxy'); page.locator('#ai-key').press('Tab')
    expect(page.locator('#ai-key')).to_have_attribute('placeholder', summary('preflight-replaced-main-key-uvwxy'))
    page.evaluate('window.__finishConfiguration()')
    expect(button).to_have_attribute('data-state', 'idle')
    assert count('testCandidate') == before
    assert_original()

    # Canceled candidates may deliver a late mock ACK, but JS must never request their commit.
    key.fill(DRAFT_KEY); start()
    busy()
    page.wait_for_function("typeof window.__finishTest==='function'")
    before, started = count('commitTestedKey'), count('testCandidate')
    button.click()
    page.evaluate('window.__finishTest()')
    expect(button).to_have_attribute('data-state', 'idle')
    assert count('testCandidate') == started
    assert count('commitTestedKey') == before and count('cancel') >= 1
    assert_original(); capture('cancelled')

    # Changes before the ACK invalidate the clicked snapshot and native candidate authority.
    for change in ('key', 'workspace', 'source', 'region', 'main'):
        shared.uncheck(); key.fill(DRAFT_KEY)
        page.locator('#voice-bailian-workspace').fill('verified-workspace')
        set_region('新加坡')
        page.evaluate('window.__finishTest=null')
        start(); page.wait_for_function("typeof window.__finishTest==='function'")
        before = count('commitTestedKey')
        if change == 'key':
            key.fill('another-uncommitted-candidate-54321')
        elif change == 'workspace':
            page.locator('#voice-bailian-workspace').fill('uncommitted-workspace')
        elif change == 'source':
            shared.check(); expect(key).to_have_value(''); expect(key).to_have_attribute('readonly', '')
        elif change == 'region':
            set_region('北京')
        else:
            page.locator('#ai-key').fill('before-ack-main-native-key-12345'); page.locator('#ai-key').press('Tab')
            expect(page.locator('#ai-key')).to_have_attribute('placeholder', summary('before-ack-main-native-key-12345'))
        page.evaluate('window.__finishTest()')
        expect(button).to_have_attribute('data-state', 'idle')
        assert count('commitTestedKey') == before
        assert_original()

    # Cancellation/source/config/main changes while commit is delayed cannot overwrite the
    # original working native snapshot. The mock rechecks authority at its commit boundary.
    page.evaluate('window.__holdTest=false;window.__holdCommit=true')
    for change in ('cancel', 'key', 'source', 'workspace', 'region', 'main'):
        shared.uncheck(); key.fill(DRAFT_KEY)
        page.locator('#voice-bailian-workspace').fill('verified-workspace')
        if page.locator('#voice-bailian-region').get_attribute('data-region') != 'singapore':
            set_region('新加坡')
        page.evaluate('window.__finishCommit=null')
        start()
        page.wait_for_function("typeof window.__finishCommit==='function'")
        busy()
        outcomes = page.evaluate('window.__voiceCommitOutcomes.length')
        if change == 'cancel':
            button.click()
        elif change == 'key':
            key.fill('changed-after-ack-candidate-klmno')
        elif change == 'source':
            shared.check()
        elif change == 'workspace':
            page.locator('#voice-bailian-workspace').fill('uncommitted-workspace')
        elif change == 'region':
            set_region('北京')
        else:
            main_revision = snapshot()['mainCredentialRevision']
            page.locator('#ai-key').fill(MAIN_KEY); page.locator('#ai-key').press('Tab')
            expect(page.locator('#ai-key')).to_have_attribute('placeholder', summary(MAIN_KEY))
            assert snapshot()['mainCredentialRevision'] != main_revision
        page.evaluate('window.__finishCommit()')
        page.wait_for_function('(n)=>window.__voiceCommitOutcomes.length>n', arg=outcomes)
        assert page.evaluate('window.__voiceCommitOutcomes.at(-1).committed') is False
        expect(button).not_to_have_attribute('data-state', 'success')
        assert_original()
    page.evaluate('window.__holdCommit=false;window.__holdTest=true;window.__finishTest=null')

    # Navigation tears down pending work; returning uses the committed native destination,
    # even though the old IndexedDB workspace remains different from that tested destination.
    shared.uncheck(); key.fill(DRAFT_KEY)
    page.locator('#voice-bailian-workspace').fill('verified-workspace')
    set_region('新加坡'); start()
    page.wait_for_function("typeof window.__finishTest==='function'")
    before, commits = count('cancel'), count('commitTestedKey')
    page.locator('#sp-ai-settings [data-act="back"]').click()
    page.wait_for_function('(n)=>window.__voiceCalls.filter(x=>x.method==="cancel").length>n', arg=before)
    page.evaluate('window.__finishTest()')
    # Closing marks the page inert immediately, then removes it after its exit transition.
    # Complete that lifecycle before reopening so locators cannot match both page instances.
    page.locator('#sp-ai-settings').wait_for(state='detached')
    page.locator('#page-mine [data-sub="sp-ai-settings"]').click()
    expect(button).not_to_have_attribute('data-state', 'success')
    expect(key).to_have_value(''); expect(key).to_have_attribute('placeholder', summary(BASE_KEY))
    expect(page.locator('#voice-bailian-workspace')).to_have_value('verified-workspace')
    expect(page.locator('#voice-bailian-region')).to_have_attribute('data-region', 'singapore')
    expect(page.locator('#voice-bailian-model')).to_have_value(DEFAULT_MODEL)
    assert count('commitTestedKey') == commits
    assert_original()

    # Shared mode is a staged source switch. Only its explicit successful native test commits.
    page.evaluate('window.__holdTest=false')
    shared.check(); expect(key).to_have_value('')
    expect(key).to_have_attribute('readonly', '')
    expect(key).to_have_attribute('placeholder', summary(MAIN_KEY))
    assert_original()
    secret_reads = page.evaluate('window.__secretCalls.length')
    start()
    succeeded()
    shared_call = page.evaluate("window.__voiceCalls.filter(x=>x.method==='testCandidate').at(-1)")
    assert shared_call['keySource'] == 'shared' and shared_call['hasValue'] is False
    assert page.evaluate('window.__secretCalls.length') == secret_reads
    assert snapshot()['keySource'] == 'shared' and snapshot()['maskedKey'] == summary(MAIN_KEY)
    expect(key).to_have_value(''); expect(key).to_have_attribute('placeholder', summary(MAIN_KEY))
    capture('shared-success')

    # A newer main Key does not silently become an active tested voice credential.
    replacement_main = 'replacement-main-native-only-fghij'
    before = count('testCandidate')
    page.locator('#ai-key').fill(replacement_main); page.locator('#ai-key').press('Tab')
    expect(page.locator('#ai-key')).to_have_attribute('placeholder', summary(replacement_main))
    expect(key).to_have_value(''); expect(key).to_have_attribute('placeholder', summary(replacement_main))
    expect(button).not_to_have_attribute('data-state', 'success')
    assert snapshot()['hasKey'] is False and count('testCandidate') == before
    start(); succeeded()
    assert snapshot()['hasKey'] and snapshot()['maskedKey'] == summary(replacement_main)
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='testCandidate').at(-1).hasValue") is False

    # Missing shared credentials cannot be tested; turning sharing off also cannot reuse a
    # previously shared key as an independently stored key without a newly entered candidate.
    page.locator('#ai-key').fill('discard-this-main-draft'); page.locator('#ai-key').fill('')
    page.locator('#ai-key').press('Tab')
    expect(page.locator('#ai-key')).to_have_attribute('placeholder', 'sk-...')
    expect(button).to_be_disabled()
    assert snapshot()['hasMainKey'] is False and snapshot()['hasKey'] is False
    shared.uncheck(); expect(key).not_to_have_attribute('readonly', '')
    expect(button).to_be_disabled()
    key.fill(DRAFT_KEY); start()
    succeeded()
    expect(key).to_have_value(''); expect(key).to_have_attribute('placeholder', summary(DRAFT_KEY))
    assert snapshot()['keySource'] == 'separate' and snapshot()['hasKey']
    assert snapshot()['activeConfig'] == {'region': 'singapore', 'workspace': 'verified-workspace', 'model': DEFAULT_MODEL}
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='testCandidate').at(-1).model") == DEFAULT_MODEL
    page.locator('#sp-ai-settings [data-act="back"]').click()
    page.locator('#sp-ai-settings').wait_for(state='detached')
    page.locator('#page-mine [data-sub="sp-ai-settings"]').click()
    expect(page.locator('#voice-bailian-model')).to_have_value(DEFAULT_MODEL)
    compact_controls()

    serialized_settings = str(read_rows(page, 'settings'))
    for secret in (BASE_KEY, DRAFT_KEY, MAIN_KEY, replacement_main, 'preflight-replaced-main-key-uvwxy', 'before-ack-main-native-key-12345'):
        assert secret not in serialized_settings
        assert secret not in page.locator('#sp-ai-settings').inner_html()
        assert page.evaluate('(s)=>!JSON.stringify({...localStorage,...sessionStorage}).includes(s)', secret)
        assert secret not in str(page.evaluate('window.__voiceCalls'))
    assert page.evaluate('window.__copiedDiagnostics.length') == 0
    assert count('setKey') == count('clearKey') == count('testConnection') == count('start') == 0
    assert page.evaluate('window.__micCalls') == 0
    assert not requests and not errors, {'requests': requests, 'errors': errors}


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for width in (360, 390, 430, 1280):
            for motion in ('reduce', 'no-preference'):
                context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block', reduced_motion=motion)
                page = context.new_page()
                try:
                    run(page, width, motion)
                except Exception:
                    # Keep the exact failed UI for the next approved browser gate, without
                    # changing or suppressing the original failing assertion.
                    try:
                        page.screenshot(path=str(OUT / f'failure-{width}-{motion}.png'), animations='disabled')
                    except Exception:
                        print('Unable to capture the voice diagnostics failure screen', flush=True)
                    raise
                finally:
                    context.close()
            print(f'PASS synthetic voice candidate transactions {width}', flush=True)
        browser.close()
