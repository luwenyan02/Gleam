"""Synthetic native settings transactions; no real credentials, audio or provider calls."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_short_voice import URL, MOCK_NATIVE, seed_config, open_voice_advanced
from test_browser_usability import assert_usable
from test_life_ai import read_rows

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/voice-shared-settings'
MODEL = 'qwen3.8-omni-flash-realtime'


def run(browser, width, theme, scale):
    context = browser.new_context(viewport={'width': width, 'height': 890}, device_scale_factor=3 if width == 400 else 1,
                                  service_workers='block', reduced_motion='reduce', timezone_id='Asia/Shanghai')
    page = context.new_page()
    page.add_init_script(MOCK_NATIVE)
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://**/*', lambda route: (external.append(route.request.url), route.abort()))
    try:
        page.goto(URL); page.locator('#fab').wait_for(); seed_config(page)
        page.evaluate('''async()=>{
          const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
          const tx=db.transaction('settings','readwrite');tx.objectStore('settings').delete('voice.bailian.workspace');
          await new Promise(r=>tx.oncomplete=r);db.close();
        }''')
        before = read_rows(page, 'entries')
        page.locator('[data-page="page-mine"]').click()
        page.locator('#page-mine [data-sub="sp-ai-settings"]').click()
        page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",String(scale));document.documentElement.style.setProperty("--safe-top","24px");document.documentElement.style.setProperty("--safe-bottom","24px")}', [theme, scale])
        card = page.locator('section[aria-label="百炼短语音"]')
        advanced = card.locator('[data-settings-detail="voice-advanced"]')
        summary = advanced.locator(':scope > summary')
        key = card.locator('#voice-bailian-key')
        workspace = card.locator('#voice-bailian-workspace')
        region = card.locator('#voice-bailian-region')
        button = card.locator('[data-voice-test]')
        snapshot = lambda: page.evaluate('window.__voiceSnapshot()')
        test_count = lambda: page.evaluate("window.__voiceCalls.filter(x=>x.method==='testCandidate').length")

        def choose_region(value):
            open_voice_advanced(page)
            region.click()
            picker = page.locator('.picker-mask[aria-label="百炼语音地域"]')
            picker.locator(f'[role="option"][data-value="{value}"]').click()
            expect(region).to_have_attribute('data-region', value)

        def test_success():
            button.click()
            expect(button).to_have_attribute('data-state', 'success')
            expect(key).to_have_value('')

        def capture(name):
            page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",String(scale))}', [theme, scale])
            page.locator('#toast.show').wait_for(state='hidden')
            card.scroll_into_view_if_needed()
            page.wait_for_timeout(180)
            assert_usable(page, 'section[aria-label="百炼短语音"]')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            for control in (summary, button):
                assert control.bounding_box()['height'] >= 44
            card.screenshot(path=str(OUT / f'{name}-{width}-{theme}-{scale}.png'), animations='disabled')

        expect(advanced).not_to_have_attribute('open', '')
        expect(workspace).to_be_hidden()
        expect(workspace).to_have_value('')
        expect(region).to_have_attribute('data-region', 'beijing')
        expect(button).to_be_visible()
        key.fill('synthetic-shared-service-key')
        assert test_count() == 0
        test_success()
        assert snapshot()['activeConfig'] == {'region': 'beijing', 'workspace': '', 'model': MODEL}
        expect(advanced).not_to_have_attribute('open', '')
        capture('default')

        # Reusing the text Key is independent of choosing the public/shared destination.
        card.locator('#voice-key-shared').check()
        expect(key).to_have_attribute('readonly', '')
        test_success()
        assert snapshot()['keySource'] == 'shared' and snapshot()['activeConfig']['workspace'] == ''

        choose_region('singapore'); workspace.fill('existing-space')
        test_success()
        existing = snapshot()
        assert existing['activeConfig'] == {'region': 'singapore', 'workspace': 'existing-space', 'model': MODEL}
        page.locator('#sp-ai-settings [data-act="back"]').click()
        page.locator('#sp-ai-settings').wait_for(state='detached')
        page.locator('#page-mine [data-sub="sp-ai-settings"]').click()
        expect(advanced).not_to_have_attribute('open', '')
        expect(region).to_have_attribute('data-region', 'singapore')
        expect(workspace).to_have_value('existing-space')
        assert snapshot() == existing
        open_voice_advanced(page)

        # Invalid drafts never call the provider or replace the working destination.
        count = test_count(); workspace.fill('invalid.example'); button.click()
        expect(button).to_have_attribute('data-state', 'error')
        assert test_count() == count and snapshot() == existing

        # Changing the destination cancels a pending success and discards its late ACK.
        workspace.fill(''); page.evaluate('window.__holdTest=true'); button.click()
        page.wait_for_function("typeof window.__finishTest==='function'")
        commits = page.evaluate('window.__voiceCommitCount')
        workspace.fill('changed-before-ack')
        page.evaluate('window.__finishTest()')
        expect(button).to_have_attribute('data-state', 'idle')
        assert page.evaluate('window.__voiceCommitCount') == commits and snapshot() == existing

        page.evaluate("window.__holdTest=false;window.__testError='SPEECH_AUTH'")
        workspace.fill(''); button.click()
        expect(button).to_have_attribute('data-state', 'error')
        assert snapshot() == existing
        page.evaluate('window.__testError=null')
        choose_region('beijing'); workspace.fill('  ')
        test_success()
        assert snapshot()['activeConfig'] == {'region': 'beijing', 'workspace': '', 'model': MODEL}

        # Collapsing and unrelated re-rendering preserve the committed empty workspace.
        summary.click()
        page.locator('#ai-thres').evaluate("e=>{e.value='85';e.dispatchEvent(new Event('change',{bubbles:true}))}")
        expect(page.locator('#ai-thres-val')).to_have_text('85%')
        expect(advanced).not_to_have_attribute('open', '')
        expect(workspace).to_have_value('')
        expect(region).to_have_attribute('data-region', 'beijing')
        assert snapshot()['activeConfig']['workspace'] == ''
        open_voice_advanced(page)
        capture('advanced')
        assert read_rows(page, 'entries') == before
        assert page.evaluate('window.__micCalls') == 0
        assert not external and not errors, (external, errors)
        print(f'PASS voice shared settings {width} {theme} {scale}', flush=True)
    except Exception:
        page.screenshot(path=str(OUT / f'failure-{width}-{theme}-{scale}.png'), animations='disabled')
        raise
    finally:
        context.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 400, 430, 1280):
            run(browser, width, 'light', 1)
        run(browser, 400, 'dark', 1.2)
        browser.close()
