"""Synthetic native candidate transactions only; never test a real Key, microphone or provider."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE, seed_config
from test_browser_usability import assert_usable
from test_life_ai import read_rows

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/voice-diagnostics'
BASE_KEY = 'fixture-voice-original-12345'
DRAFT_KEY = 'draft-voice-replacement-67890'
MAIN_KEY = 'changed-main-native-only-abcde'
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
    page.get_by_role('button', name='应用设置', exact=True).click()
    key = page.locator('#voice-bailian-key')
    shared = page.locator('#voice-key-shared')
    status = page.locator('[data-voice-test-status]')
    count = lambda method: page.evaluate('(m)=>window.__voiceCalls.filter(x=>x.method===m).length', method)
    snapshot = lambda: page.evaluate('window.__voiceSnapshot()')

    def capture(name):
        page.locator('[aria-label="百炼短语音"]').scroll_into_view_if_needed()
        page.locator('#toast.show').wait_for(state='hidden')
        page.wait_for_timeout(220)
        assert_usable(page, '[aria-label="百炼短语音"]')
        page.screenshot(path=str(OUT / f'{name}-{width}-{motion}.png'), animations='disabled')

    def consent(region='新加坡'):
        page.locator('[data-voice-test]').click()
        expect(page.locator('[data-voice-test-consent]')).to_be_visible()
        expect(page.locator('[data-voice-test-recipient]')).to_have_text(f'阿里云百炼 · {region}')
        expect(page.locator('[data-voice-test-confirm]')).to_have_text('开始测试')

    def confirm():
        page.locator('[data-voice-test-confirm]').click()

    def set_region(name):
        page.locator('#voice-bailian-region').click()
        page.get_by_role('option', name=name, exact=True).click()
        page.locator('.picker-mask').wait_for(state='detached')

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
    expect(page.locator('[data-voice-test]')).to_be_disabled()
    expect(page.locator('[data-voice-save-key], [data-voice-clear-key], [data-voice-key-status]')).to_have_count(0)
    key.fill(BASE_KEY); key.press('Tab')
    page.locator('#voice-bailian-workspace').fill('verified-workspace')
    page.locator('#voice-bailian-workspace').press('Tab')
    set_region('新加坡')
    assert snapshot()['hasKey'] is False
    assert count('testCandidate') == count('commitTestedKey') == count('start') == 0
    rows = read_rows(page, 'settings')
    assert next(row['value'] for row in rows if row['key'] == 'voice.bailian.workspace') == 'synthetic-workspace'
    assert not any(row['key'] == 'voice.bailian.region' and row['value'] == 'singapore' for row in rows)

    consent(); capture('consent')
    assert count('testCandidate') == count('commitTestedKey') == 0
    page.locator('[data-voice-test-cancel]').click()
    expect(page.locator('[data-voice-test-consent]')).to_be_hidden()
    assert count('testCandidate') == count('commitTestedKey') == 0
    assert snapshot()['hasKey'] is False

    # Neither staging nor an in-flight candidate changes the active credentials/destination.
    page.evaluate('window.__holdTest=true')
    consent(); confirm()
    expect(status).to_have_attribute('data-state', 'testing')
    page.wait_for_function("typeof window.__finishTest==='function'")
    page.locator('[data-voice-test-confirm]').dispatch_event('click')
    page.locator('[data-voice-test]').dispatch_event('click')
    assert count('testCandidate') == 1 and count('commitTestedKey') == 0
    assert snapshot()['hasKey'] is False
    # An unrelated settings refresh preserves the active transaction and keeps duplicate
    # controls disabled; it cannot write the pending candidate or restore an old success.
    page.evaluate('''() => {
      window.__oldVoiceInput=document.querySelector('#voice-bailian-key');
      const threshold=document.querySelector('#ai-thres');threshold.value='90';
      threshold.dispatchEvent(new Event('change',{bubbles:true}));
    }''')
    page.wait_for_function("document.querySelector('#voice-bailian-key')!==window.__oldVoiceInput")
    expect(page.locator('[data-voice-test]')).to_be_disabled()
    expect(status).to_have_attribute('data-state', 'testing')
    assert count('testCandidate') == 1 and count('commitTestedKey') == 0
    assert snapshot()['hasKey'] is False
    capture('testing')
    page.evaluate('window.__holdTest=false;window.__finishTest()')
    expect(status).to_have_attribute('data-state', 'success')
    expect(status).to_contain_text('录音未测试')
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
    capture('success')

    # Editing does not save; failure diagnostics are sanitized, copied only on explicit action.
    key.fill(DRAFT_KEY)
    expect(status).not_to_have_attribute('data-state', 'success')
    assert_original()
    page.evaluate("window.__testError='SPEECH_PROTOCOL'")
    consent(); confirm()
    expect(status).to_have_attribute('data-state', 'error')
    for text in ('SPEECH_PROTOCOL', 'ACK_MODEL_MISMATCH', 'ACK_AUDIO_FORMAT_MISSING'):
        expect(status).to_contain_text(text)
    for text in ('PRIVATE_PROVIDER_BODY', 'PRIVATE_UNKNOWN_REASON'):
        expect(status).not_to_contain_text(text)
    assert count('commitTestedKey') == 1
    assert_original()
    assert page.evaluate('window.__copiedDiagnostics.length') == 0
    page.locator('[data-voice-test-copy]').click()
    expect(page.locator('[data-voice-test-copy-status]')).to_contain_text('复制')
    copied = page.evaluate('window.__copiedDiagnostics')
    assert len(copied) == 1 and 'ACK_MODEL_MISMATCH' in copied[0] and 'ACK_AUDIO_FORMAT_MISSING' in copied[0]
    assert not any(secret in copied[0] for secret in ['PRIVATE_PROVIDER_BODY', 'PRIVATE_UNKNOWN_REASON', 'verified-workspace', BASE_KEY, DRAFT_KEY])
    capture('error')

    # A provider success still cannot count as success if native durable storage fails.
    page.evaluate("window.__testError=null;window.__commitError='SPEECH_KEY_STORAGE'")
    key.fill(DRAFT_KEY); consent(); confirm()
    expect(status).to_have_attribute('data-state', 'error')
    expect(status).to_contain_text('SPEECH_KEY_STORAGE')
    assert_original()
    page.evaluate('window.__commitError=null;window.__holdTest=true;window.__finishTest=null')

    # A main-key edit while consent is open consumes that consent without starting a test.
    key.fill(DRAFT_KEY); consent()
    before = count('testCandidate')
    page.locator('#ai-key').fill('consent-replaced-main-key-uvwxy'); page.locator('#ai-key').press('Tab')
    expect(page.locator('#ai-key')).to_have_attribute('placeholder', summary('consent-replaced-main-key-uvwxy'))
    expect(page.locator('[data-voice-test-consent]')).to_be_hidden()
    page.locator('[data-voice-test-confirm]').dispatch_event('click')
    assert count('testCandidate') == before
    assert_original()

    # Canceled candidates may deliver a late mock ACK, but JS must never request their commit.
    key.fill(DRAFT_KEY); consent(); confirm()
    expect(status).to_have_attribute('data-state', 'testing')
    page.wait_for_function("typeof window.__finishTest==='function'")
    before = count('commitTestedKey')
    page.locator('[data-voice-test-cancel]').click()
    page.evaluate('window.__finishTest()')
    expect(status).to_have_attribute('data-state', 'idle')
    assert count('commitTestedKey') == before and count('cancel') >= 1
    assert_original(); capture('cancelled')

    # Changes before the ACK invalidate both UI consent and native candidate authority.
    for change in ('key', 'workspace', 'source'):
        shared.uncheck(); key.fill(DRAFT_KEY)
        page.locator('#voice-bailian-workspace').fill('verified-workspace')
        page.evaluate('window.__finishTest=null')
        consent(); confirm(); page.wait_for_function("typeof window.__finishTest==='function'")
        before = count('commitTestedKey')
        if change == 'key':
            key.fill('another-uncommitted-candidate-54321')
        elif change == 'workspace':
            page.locator('#voice-bailian-workspace').fill('uncommitted-workspace')
        else:
            shared.check(); expect(key).to_have_value(''); expect(key).to_have_attribute('readonly', '')
        page.evaluate('window.__finishTest()')
        expect(status).to_have_attribute('data-state', 'idle')
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
        consent(); confirm()
        page.wait_for_function("typeof window.__finishCommit==='function'")
        expect(status).to_have_attribute('data-state', 'testing')
        outcomes = page.evaluate('window.__voiceCommitOutcomes.length')
        if change == 'cancel':
            page.locator('[data-voice-test-cancel]').click()
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
        expect(status).not_to_have_attribute('data-state', 'success')
        assert_original()
    page.evaluate('window.__holdCommit=false;window.__holdTest=true;window.__finishTest=null')

    # Navigation tears down pending work; returning uses the committed native destination,
    # even though the old IndexedDB workspace remains different from that tested destination.
    shared.uncheck(); key.fill(DRAFT_KEY)
    page.locator('#voice-bailian-workspace').fill('verified-workspace')
    set_region('新加坡'); consent(); confirm()
    page.wait_for_function("typeof window.__finishTest==='function'")
    before, commits = count('cancel'), count('commitTestedKey')
    page.locator('#sp-settings [data-act="back"]').click()
    page.wait_for_function('(n)=>window.__voiceCalls.filter(x=>x.method==="cancel").length>n', arg=before)
    page.evaluate('window.__finishTest()')
    page.get_by_role('button', name='应用设置', exact=True).click()
    expect(status).not_to_have_attribute('data-state', 'success')
    expect(key).to_have_value(''); expect(key).to_have_attribute('placeholder', summary(BASE_KEY))
    expect(page.locator('#voice-bailian-workspace')).to_have_value('verified-workspace')
    expect(page.locator('#voice-bailian-region')).to_have_attribute('data-region', 'singapore')
    assert count('commitTestedKey') == commits
    assert_original()

    # Shared mode is a staged source switch. Only its explicit successful native test commits.
    page.evaluate('window.__holdTest=false')
    shared.check(); expect(key).to_have_value('')
    expect(key).to_have_attribute('readonly', '')
    expect(key).to_have_attribute('placeholder', summary(MAIN_KEY))
    assert_original()
    secret_reads = page.evaluate('window.__secretCalls.length')
    consent(); confirm()
    expect(status).to_have_attribute('data-state', 'success')
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
    expect(status).not_to_have_attribute('data-state', 'success')
    assert snapshot()['hasKey'] is False and count('testCandidate') == before
    consent(); confirm(); expect(status).to_have_attribute('data-state', 'success')
    assert snapshot()['hasKey'] and snapshot()['maskedKey'] == summary(replacement_main)
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='testCandidate').at(-1).hasValue") is False

    # Missing shared credentials cannot be tested; turning sharing off also cannot reuse a
    # previously shared key as an independently stored key without a newly entered candidate.
    page.locator('#ai-key').fill('discard-this-main-draft'); page.locator('#ai-key').fill('')
    page.locator('#ai-key').press('Tab')
    expect(page.locator('#ai-key')).to_have_attribute('placeholder', 'sk-...')
    expect(page.locator('[data-voice-test]')).to_be_disabled()
    assert snapshot()['hasMainKey'] is False and snapshot()['hasKey'] is False
    shared.uncheck(); expect(key).not_to_have_attribute('readonly', '')
    expect(page.locator('[data-voice-test]')).to_be_disabled()
    key.fill(DRAFT_KEY); consent(); confirm()
    expect(status).to_have_attribute('data-state', 'success')
    expect(key).to_have_value(''); expect(key).to_have_attribute('placeholder', summary(DRAFT_KEY))
    assert snapshot()['keySource'] == 'separate' and snapshot()['hasKey']

    serialized_settings = str(read_rows(page, 'settings'))
    for secret in (BASE_KEY, DRAFT_KEY, MAIN_KEY, replacement_main):
        assert secret not in serialized_settings
        assert secret not in page.locator('#sp-settings').inner_html()
        assert page.evaluate('(s)=>!JSON.stringify({...localStorage,...sessionStorage}).includes(s)', secret)
        assert secret not in str(page.evaluate('window.__voiceCalls'))
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
                run(context.new_page(), width, motion); context.close()
            print(f'PASS synthetic voice candidate transactions {width}', flush=True)
        browser.close()
