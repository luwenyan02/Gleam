"""Shared inbox voice: readiness, stale ASR/draft reads, keyboard/back and reduced motion."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_inbox_hold_voice import setup,open_voice,start,pending,OUT
from test_hold_voice import center,preview,release_at
from test_hold_voice_handoff import gate
from test_refund_layout import state
from test_browser_usability import assert_usable


def preparing(browser):
    context,page,errors,requests=setup(browser)
    try:
        before=state(page);open_voice(page);page.evaluate('window.__holdNextConfiguration=true')
        page.mouse.move(*center(page.locator('[data-hv-hold]')));page.mouse.down()
        expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','preparing')
        expect(page.locator('[data-hv-status]')).to_have_text('正在准备语音…')
        release_at(page,'edit');expect(page.locator('[data-hv-text]')).to_have_value('')
        page.locator('[data-hv-text]').fill('虚构手动文字');page.evaluate('window.__finishConfiguration()')
        expect(page.locator('[data-hv-text]')).to_have_value('虚构手动文字')
        assert not any(c['method']=='start' for c in page.evaluate('window.__voiceCalls'))
        page.locator('[data-hv-close]').click();assert state(page)==before and not requests and not errors
    finally:context.close()


def empty_final_edit(browser):
    context,page,errors,requests=setup(browser)
    try:
        before=state(page);open_voice(page);page.evaluate('window.__waitFinal=true')
        sid=start(page);release_at(page,'send')
        expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','transcribing')
        page.locator('[data-hv-zone="edit"]').click();expect(page.locator('[data-hv-text]')).to_have_value('')
        page.locator('[data-hv-text]').fill('保留的虚构手改文字')
        page.evaluate("id=>window.__voicePending.get(id)?.resolve({sessionId:id,text:'迟到最终文字'})",sid)
        expect(page.locator('[data-hv-text]')).to_have_value('保留的虚构手改文字')
        page.locator('[data-hv-close]').click();assert state(page)==before and not requests and not errors
    finally:context.close()


def delayed_draft(browser):
    context,page,errors,requests=setup(browser)
    try:
        before=state(page);queue=pending(page);open_voice(page);page.locator('[data-hv-zone="edit"]').click()
        page.locator('[data-hv-text]').fill('虚构午餐28元现金');gate(page)
        page.locator('[data-hv-send]').click();expect(page.locator('[data-hv-message]')).to_have_text('正在打开草稿…')
        expect(page.locator('.hold-voice-mask')).to_be_visible();expect(page.locator('#sheet.open')).to_have_count(0)
        page.locator('[data-hv-close]').click();page.evaluate('window.__releaseDraft=true');page.wait_for_timeout(180)
        expect(page.locator('#sheet.open')).to_have_count(0);expect(page.locator('[data-act="short-voice"]')).to_be_focused()
        assert state(page)==before and pending(page)==queue and len(requests)==1 and not errors
    finally:
        page.evaluate('window.__releaseDraft=true');context.close()


def unreadable_draft(browser):
    context,page,errors,requests=setup(browser)
    try:
        before=state(page);open_voice(page);page.locator('[data-hv-zone="edit"]').click()
        page.locator('[data-hv-text]').fill('虚构午餐28元现金')
        page.evaluate("""()=>{const get=IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get=function(key){
        if(window.__failDraft&&key==='entry.lastUsed')throw new DOMException('SYNTHETIC_READ_FAILURE','AbortError');
        return get.call(this,key)};window.__failDraft=true}""")
        page.locator('[data-hv-send]').click();expect(page.locator('[data-hv-message]')).to_contain_text('草稿未打开')
        expect(page.locator('[data-hv-text]')).to_have_value('虚构午餐28元现金');expect(page.locator('#sheet.open')).to_have_count(0)
        page.evaluate('window.__failDraft=false');page.locator('[data-hv-close]').click()
        assert state(page)==before and len(requests)==1 and not errors
    finally:context.close()


def keyboard_and_motion(browser,width,motion):
    context,page,errors,requests=setup(browser,width=width)
    try:
        page.emulate_media(reduced_motion=motion);before=state(page);open_voice(page)
        expect(page.locator('[data-hv-hold]')).to_be_focused()
        page.keyboard.press('Enter');expect(page.locator('[data-hv-text]')).to_have_value('')
        page.locator('[data-hv-rerecord]').click();start(page)
        animation=page.locator('.hold-voice-wave i').evaluate_all('es=>es.map(e=>getComputedStyle(e).animationName)')
        assert all(n=='none' for n in animation) if motion=='reduce' else any(n=='hold-voice-wave' for n in animation)
        preview(page,'虚构连续转写');assert_usable(page,'.hold-voice-stage')
        release_at(page,'edit');page.go_back();expect(page.locator('.hold-voice-mask')).to_have_count(0)
        expect(page.locator('#sp-ai-inbox')).to_be_visible();expect(page.locator('[data-act="short-voice"]')).to_be_focused()
        starts=page.evaluate("window.__voiceCalls.filter(c=>c.method==='start').length")
        page.go_forward();expect(page.locator('.hold-voice-mask')).to_have_count(0)
        assert page.evaluate("window.__voiceCalls.filter(c=>c.method==='start').length")==starts
        assert state(page)==before and not requests and not errors
    finally:context.close()


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for test in [preparing,empty_final_edit,delayed_draft,unreadable_draft]:test(browser);print('PASS inbox',test.__name__,flush=True)
        for width in [360,390,430,1280]:
            for motion in ['reduce','no-preference']:keyboard_and_motion(browser,width,motion)
        print('PASS inbox keyboard, back/forward and motion: 8 profiles',flush=True)
        browser.close()
