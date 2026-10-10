"""Connection diagnostics use only synthetic native replies; forbid real microphone/network."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE, seed_config
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/voice-diagnostics'
MOCK = MOCK_NATIVE.replace("'clearKey','start'", "'clearKey','testConnection','start'").replace(
    "if (method === 'start') {", """
      if (method === 'testConnection') {
        if (window.__testError) throw {code:window.__testError,data:{phase:'configuring',reason:'ACK_MODEL_MISMATCH',reasons:['ACK_MODEL_MISMATCH','ACK_AUDIO_FORMAT_MISSING','PRIVATE_UNKNOWN_REASON']},message:'PRIVATE_PROVIDER_BODY'};
        if (window.__holdTest) return new Promise(resolve => { window.__finishTest=()=>resolve({sessionId:options.sessionId,connected:true}); });
        return {sessionId:options.sessionId,connected:true};
      }
      if (method === 'start') {""")

MOCK += r""";(() => {
  window.__copiedDiagnostics = [];
  Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => {window.__copiedDiagnostics.push(text);}}});
})()"""


def run(page, width):
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(MOCK)
    page.route('https://**/*', lambda route: route.abort())
    page.on('request', lambda req: requests.append(req.url) if req.url.startswith('https://') else None)
    page.goto(URL); page.locator('#fab').wait_for(); seed_config(page)
    page.locator('[data-page="page-mine"]').click()
    page.get_by_role('button', name='应用设置', exact=True).click()
    page.locator('#voice-bailian-key').fill('synthetic-diagnostic-key')
    page.locator('[data-voice-save-key]').click()
    expect(page.locator('[data-voice-key-status]')).to_contain_text('已保存')
    count = lambda method: page.evaluate('(m)=>window.__voiceCalls.filter(x=>x.method===m).length', method)
    assert count('testConnection') == count('start') == 0

    def consent():
        page.locator('[data-voice-test]').click()
        expect(page.locator('[data-voice-test-consent]')).to_be_visible()
        expect(page.locator('[data-voice-test-recipient]')).to_contain_text('synthetic-workspace.cn-beijing.maas.aliyuncs.com')
        expect(page.locator('[data-voice-test-consent]')).to_contain_text('费用')

    consent()
    assert count('testConnection') == 0
    page.locator('[data-voice-test-cancel]').click()
    expect(page.locator('[data-voice-test-consent]')).to_be_hidden()
    assert count('testConnection') == 0

    consent(); page.locator('[data-voice-test-confirm]').click()
    expect(page.locator('[data-voice-test-status]')).to_have_attribute('data-state', 'success')
    expect(page.locator('[data-voice-test-status]')).to_contain_text('未')
    assert count('testConnection') == 1 and count('start') == 0
    assert page.evaluate('window.__micCalls') == 0
    page.locator('[data-voice-test-status]').scroll_into_view_if_needed()
    page.locator('#toast.show').wait_for(state='hidden')
    assert_usable(page, '[aria-label="百炼短语音"]')
    page.screenshot(path=str(OUT / f'success-{width}.png'), animations='disabled')

    # A raw unsaved Key edit invalidates success without sending/saving the new secret.
    page.locator('#voice-bailian-key').fill('unsaved-synthetic-key')
    expect(page.locator('[data-voice-test-status]')).not_to_have_attribute('data-state', 'success')
    page.locator('#voice-bailian-key').fill('')
    page.evaluate("window.__testError='SPEECH_PROTOCOL'")
    consent(); page.locator('[data-voice-test-confirm]').click()
    expect(page.locator('[data-voice-test-status]')).to_have_attribute('data-state', 'error')
    expect(page.locator('[data-voice-test-status]')).to_contain_text('SPEECH_PROTOCOL')
    expect(page.locator('[data-voice-test-status]')).not_to_contain_text('PRIVATE_PROVIDER_BODY')
    expect(page.locator('[data-voice-test-status]')).not_to_contain_text('PRIVATE_UNKNOWN_REASON')
    expect(page.locator('[data-voice-test-status]')).to_contain_text('ACK_MODEL_MISMATCH')
    expect(page.locator('[data-voice-test-status]')).to_contain_text('ACK_AUDIO_FORMAT_MISSING')
    assert page.evaluate('window.__copiedDiagnostics.length') == 0
    page.locator('[data-voice-test-copy]').click()
    expect(page.locator('[data-voice-test-copy-status]')).to_contain_text('复制')
    copied = page.evaluate('window.__copiedDiagnostics')
    assert len(copied) == 1 and 'ACK_MODEL_MISMATCH' in copied[0] and 'ACK_AUDIO_FORMAT_MISSING' in copied[0]
    assert not any(secret in copied[0] for secret in ['PRIVATE_PROVIDER_BODY', 'PRIVATE_UNKNOWN_REASON', 'synthetic-workspace', 'synthetic-diagnostic-key'])
    page.locator('[data-voice-test-status]').scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / f'error-{width}.png'), animations='disabled')

    # Canceled/late test completions cannot restore a successful result.
    page.evaluate('window.__testError=null;window.__holdTest=true')
    consent(); page.locator('[data-voice-test-confirm]').click()
    expect(page.locator('[data-voice-test-status]')).to_have_attribute('data-state', 'testing')
    page.wait_for_function("typeof window.__finishTest==='function'")
    page.locator('[data-voice-test-cancel]').click()
    page.evaluate('window.__finishTest()')
    expect(page.locator('[data-voice-test-status]')).not_to_have_attribute('data-state', 'success')
    assert count('cancel') >= 1

    # Navigating away tears down pending work, no automatic test or recording on return.
    page.evaluate('window.__finishTest=null')
    consent(); page.locator('[data-voice-test-confirm]').click()
    page.wait_for_function("typeof window.__finishTest==='function'")
    expect(page.locator('[data-voice-test-status]')).to_have_attribute('data-state', 'testing')
    before = count('cancel')
    page.locator('#sp-settings [data-act="back"]').click()
    page.wait_for_function('(n)=>window.__voiceCalls.filter(x=>x.method===\'cancel\').length>n', arg=before)
    page.evaluate('window.__finishTest()')
    page.get_by_role('button', name='应用设置', exact=True).click()
    expect(page.locator('[data-voice-test-status]')).not_to_have_attribute('data-state', 'success')
    assert count('start') == 0 and page.evaluate('window.__micCalls') == 0
    assert not requests and not errors, {'requests': requests, 'errors': errors}


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for width in (360, 390, 430, 1280):
            page = browser.new_page(viewport={'width': width, 'height': 900}, is_mobile=width < 600)
            run(page, width); page.close()
        browser.close()
    print('Voice diagnostics: 4 widths passed; no real microphone or provider requests')
