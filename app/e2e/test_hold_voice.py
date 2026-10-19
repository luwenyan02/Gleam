"""Home hold-to-talk gestures and manual ledger confirmation; synthetic native bridge only."""
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE, seed_config
from test_refund_layout import SEED, state
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/hold-voice'
MOCK = MOCK_NATIVE.replace(
    "window.__voiceListeners.forEach(callback => callback({sessionId:options.sessionId,state:'listening'}));",
    "if(!window.__holdListening) window.__voiceListeners.forEach(callback => callback({sessionId:options.sessionId,state:'listening'}));"
) + ';window.__voiceHasKey=true;'


def center(locator):
    b = locator.bounding_box()
    assert b, 'Missing gesture target'
    return b['x'] + b['width']/2, b['y'] + b['height']/2


def hold(page):
    page.mouse.move(*center(page.locator('#fab'))); page.mouse.down()
    page.wait_for_timeout(540)
    expect(page.locator('.hold-voice-mask')).to_be_visible()
    page.wait_for_function("window.__voiceCalls.filter(c=>c.method==='start').length>0")
    expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','listening')
    return page.evaluate("window.__voiceCalls.filter(c=>c.method==='start').at(-1).sessionId")


def preview(page,text,session=None):
    page.evaluate('''([text,id])=>{id??=window.__voiceCalls.filter(c=>c.method==='start').at(-1).sessionId;
     window.__voiceListeners.forEach(cb=>cb({sessionId:id,state:'listening',text}));}''',[text,session])


def release_at(page,zone):
    selector = '[data-hv-hold]' if zone=='send' else f'[data-hv-zone="{zone}"]'
    page.mouse.move(*center(page.locator(selector)))
    page.mouse.up()


def run(browser,width,height,theme,scale,safe):
    context=browser.new_context(viewport={'width':width,'height':height},timezone_id='Asia/Shanghai',service_workers='block')
    page=context.new_page();page.add_init_script(MOCK);errors=[];requests=[];waiting=[];hold_network=False
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('https://**/*',lambda route:route.abort())
    def model(route):
        payload=route.request.post_data_json;requests.append(payload)
        if hold_network:waiting.append(route);return
        text=payload['messages'][-1]['content']
        bill=[] if '天气' in text else [{'type':'expense','amount':'18.25' if '18.25' in text else '28.01',
          'category':'餐饮/午餐','account':'虚构现金','time':'2026-10-19 12:00','note':'虚构语音午餐','confidence':100}]
        route.fulfill(json={'choices':[{'message':{'content':json.dumps(bill,ensure_ascii=False)}}]})
    page.route('https://short-voice.invalid/**',model)
    page.goto(URL);page.locator('#fab').wait_for();seed_config(page)
    page.evaluate(SEED.replace('虚构退款账户长名称用于检查布局','虚构现金'))
    page.evaluate('''async theme=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('settings','readwrite');tx.objectStore('settings').put({key:'theme.mode',value:theme});
      await new Promise(resolve=>tx.oncomplete=resolve);db.close();}''',theme)
    page.reload();page.locator('#fab').wait_for()
    page.evaluate('''([theme,scale,safe])=>{document.documentElement.dataset.theme=theme;
     document.documentElement.style.setProperty('--seed-type',scale);document.documentElement.style.setProperty('--safe-bottom',safe+'px')}''',[theme,str(scale),safe])
    before=state(page)
    def capture(name):
        page.wait_for_timeout(180);assert_usable(page,'.hold-voice-stage')
        assert page.evaluate('document.documentElement.dataset.theme==="dark"')==(theme=='dark')
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        bounds=page.locator('[data-hv-send]' if page.locator('[data-hv-editor]').is_visible() else '[data-hv-hold]').bounding_box()
        assert bounds and bounds['y']>=0 and bounds['y']+bounds['height']<=height-safe+1,bounds
        if page.locator('[data-hv-capture]').is_visible():
            bubble=page.locator('.hold-voice-bubble').bounding_box()
            status=page.locator('[data-hv-status]').bounding_box()
            choices=page.locator('.hold-voice-choices').bounding_box()
            tip=page.locator('[data-hv-tip]').bounding_box()
            assert bubble['y']+bubble['height']<=status['y']+1
            assert status['y']+status['height']<=choices['y']+1
            assert tip['y']+tip['height']<=height-safe+1,tip
        else:
            header=page.locator('.hold-voice-editor-heading').bounding_box()
            exit=page.locator('[data-hv-close]').bounding_box()
            assert exit['x']>=header['x'] and exit['y']>=header['y']
            assert exit['x']+exit['width']<=header['x']+header['width']+1
        page.screenshot(path=str(OUT/f'{name}-{width}-{theme}-{scale}.png'),animations='disabled')
    def none():
        expect(page.locator('.hold-voice-mask')).to_have_count(0)
        expect(page.locator('#sheet.open')).to_have_count(0)
    page.locator('#fab').click();page.locator('#keypad').wait_for()
    page.locator('#sheet-close').click();expect(page.locator('#sheet.open')).to_have_count(0)
    sid=hold(page);expect(page.locator('[data-hv-wave]')).to_be_visible()
    expect(page.locator('[data-hv-close]')).to_be_hidden();capture('listening')
    preview(page,'午餐28元','stale');expect(page.locator('[data-hv-transcript]')).to_have_text('')
    preview(page,'今天午餐');preview(page,'今天午餐28.01元，虚构现金')
    expect(page.locator('[data-hv-transcript]')).to_have_text('今天午餐28.01元，虚构现金')
    expect(page.locator('[data-hv-wave]')).to_be_hidden();capture('transcript')
    if height==560:
        preview(page,'虚构长语音文字'*70);capture('long-transcript')
        preview(page,'今天午餐28.01元，虚构现金')
    page.mouse.move(*center(page.locator('[data-hv-zone="cancel"]')))
    expect(page.locator('[data-hv-zone="cancel"]')).to_have_class('selected');capture('cancel-selected')
    page.mouse.move(*center(page.locator('[data-hv-hold]')))
    haptics=page.evaluate('window.__haptics')
    page.mouse.move(*center(page.locator('[data-hv-zone="edit"]')))
    expect(page.locator('[data-hv-zone="edit"]')).to_have_class('selected')
    assert page.evaluate('window.__haptics')==haptics+1
    page.mouse.move(*center(page.locator('[data-hv-zone="edit"]')))
    assert page.evaluate('window.__haptics')==haptics+1
    capture('edit-selected')
    page.mouse.move(*center(page.locator('[data-hv-hold]')))
    expect(page.locator('.hold-voice-mask')).to_have_attribute('data-zone','send')
    preview(page,'继续说话仍在本次录音')
    release_at(page,'cancel');none();assert not requests and state(page)==before
    page.evaluate("id=>window.__voicePending.get(id).resolve({sessionId:id,text:'取消后迟到文字'})",sid)
    page.wait_for_timeout(100);none()
    page.evaluate("window.__voiceText=''");hold(page);release_at(page,'send');none();assert not requests
    page.evaluate("window.__voiceText='今天午餐28.01元，虚构现金'")
    # Edit immediately opens even empty, never waiting for final ASR or requesting AI.
    sid=hold(page);release_at(page,'edit')
    expect(page.locator('[data-hv-editor]')).to_be_visible()
    expect(page.locator('[data-hv-text]')).to_have_value('')
    expect(page.locator('[data-hv-send]')).to_be_disabled()
    expect(page.locator('[data-hv-close]')).to_have_text('退出')
    assert not requests
    page.locator('[data-hv-text]').fill('手填内容')
    page.evaluate("id=>window.__voicePending.get(id).resolve({sessionId:id,text:'迟到的最终文字'})",sid)
    page.wait_for_timeout(100)
    expect(page.locator('[data-hv-text]')).to_have_value('手填内容')
    page.locator('[data-hv-close]').click();none()
    hold(page);preview(page,'今天午餐28.01元，虚构现金');release_at(page,'edit')
    expect(page.locator('[data-hv-text]')).to_have_value('今天午餐28.01元，虚构现金')
    assert not requests;capture('editor')
    page.locator('[data-hv-text]').fill('虚构午餐18.25元，现金')
    page.locator('[data-hv-send]').click();page.locator('#keypad').wait_for()
    expect(page.locator('#amt')).to_have_text('18.25')
    expect(page.locator('#note')).to_have_value('虚构语音午餐')
    assert requests[-1]['messages'][-1]['content']=='虚构午餐18.25元，现金'
    assert state(page)==before,'Voice draft wrote ledger without Save'
    page.locator('#note').fill('用户手改后保存')
    page.locator('#note').blur()
    page.locator('#keypad [data-k="save"]').click();expect(page.locator('#sheet.open')).to_have_count(0)
    after=state(page);new=[e for e in after['entries'] if e['id']!=8101]
    assert len(new)==1 and new[0]['amount']==1825 and new[0]['note']=='用户手改后保存'
    assert next(a for a in after['accounts'] if a['id']==9001)['balance']==100000-1825
    assert next(e for e in after['entries'] if e['id']==8101)==before['entries'][0]
    before=after
    hold(page);release_at(page,'send');page.locator('#keypad').wait_for()
    expect(page.locator('#amt')).to_have_text('28.01');assert state(page)==before
    page.locator('#sheet-close').click();expect(page.locator('#sheet.open')).to_have_count(0)
    page.evaluate("window.__voiceText='今天天气不错'");hold(page);release_at(page,'send')
    expect(page.locator('[data-hv-editor]')).to_be_visible()
    expect(page.locator('[data-hv-text]')).to_have_value('今天天气不错')
    expect(page.locator('[data-hv-message]')).to_contain_text('补充用途和金额');capture('insufficient')
    page.locator('[data-hv-rerecord]').click();expect(page.locator('[data-hv-cue]')).to_have_text('按住说话')
    expect(page.locator('[data-hv-transcript]')).to_have_text('')
    assert page.locator('[data-hv-text]').input_value()==''
    capture('rerecord-ready')
    page.mouse.move(*center(page.locator('[data-hv-hold]')));page.mouse.down()
    expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','listening')
    preview(page,'新录音内容');expect(page.locator('[data-hv-transcript]')).to_have_text('新录音内容')
    release_at(page,'cancel');none()
    # A back press stops capture rather than falling through to App.exitApp.
    sid=hold(page);count=len(requests)
    page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))');page.mouse.up();none()
    assert len(requests)==count and state(page)==before
    page.evaluate("id=>window.__voicePending.get(id).resolve({sessionId:id,text:'返回后迟到'})",sid)
    page.wait_for_timeout(80);none()
    if width==390:
        # Back while text AI is in flight cannot reopen a draft from its late response.
        hold_network=True;page.evaluate("window.__voiceText='虚构午餐28元'")
        hold(page);release_at(page,'send');page.wait_for_function('document.querySelector("[data-hv-status]")?.textContent.includes("识别")')
        page.wait_for_timeout(100);assert waiting
        page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))');none()
        for route in waiting:
            try:route.fulfill(json={'choices':[{'message':{'content':'[{"type":"expense","amount":"28","confidence":100}]'}}]})
            except Exception:pass
        hold_network=False;page.wait_for_timeout(150);none();assert state(page)==before
        # Connecting/permission waits and browser pointer cancellation never submit.
        page.evaluate('window.__holdListening=true')
        page.mouse.move(*center(page.locator('#fab')));page.mouse.down();page.wait_for_timeout(550)
        expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','connecting')
        release_at(page,'send');none();page.evaluate('window.__holdListening=false')
        hold(page);page.evaluate('window.dispatchEvent(new PointerEvent("pointercancel",{pointerId:1}))');page.mouse.up();none()
        hold(page);page.go_back();page.mouse.up();none();assert state(page)==before
    assert page.evaluate('window.__micCalls')==0
    assert not errors,errors
    context.close();print('PASS home hold voice, gesture targets, manual Save and stale isolation',width,height,theme,scale,safe,flush=True)


def run_unavailable(browser):
    # Desktop never asks for browser microphone access; still offers editable text.
    context=browser.new_context(viewport={'width':390,'height':700},service_workers='block')
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('https://**/*',lambda route:route.abort())
    page.goto(URL);page.locator('#fab').wait_for()
    page.mouse.move(*center(page.locator('#fab')));page.mouse.down();page.wait_for_timeout(550)
    expect(page.locator('[data-hv-editor]')).to_be_visible();page.mouse.up()
    expect(page.locator('[data-hv-message]')).to_contain_text('仅支持 Android')
    expect(page.locator('[data-hv-text]')).to_be_enabled()
    page.keyboard.press('Escape');expect(page.locator('.hold-voice-mask')).to_have_count(0)
    assert not errors,errors;context.close()
    # Permission failure, missing keys and interrupted pointers preserve ledger state.
    context=browser.new_context(viewport={'width':390,'height':700},service_workers='block')
    page=context.new_page();page.add_init_script(MOCK)
    calls=[]
    def reject_external(route):
        calls.append(route.request.url);route.abort()
    page.route('https://**/*',reject_external)
    page.goto(URL);page.locator('#fab').wait_for();seed_config(page);before=state(page)
    for value,message in [('SPEECH_PERMISSION_DENIED','麦克风权限'),(None,'完成百炼短语音配置')]:
        page.evaluate('error=>{window.__voiceError=error;window.__voiceHasKey=!!error}',value)
        page.mouse.move(*center(page.locator('#fab')));page.mouse.down();page.wait_for_timeout(550)
        expect(page.locator('[data-hv-editor]')).to_be_visible();page.mouse.up()
        expect(page.locator('[data-hv-message]')).to_contain_text(message)
        page.locator('[data-hv-close]').click();expect(page.locator('.hold-voice-mask')).to_have_count(0)
    page.evaluate('window.__voiceError=null;window.__voiceHasKey=true')
    hold(page);preview(page,'今天午餐28.01元，现金')
    bounds=page.locator('[data-hv-zone="edit"]').bounding_box()
    page.mouse.move(bounds['x']+bounds['width']/2,bounds['y']+bounds['height']-1)
    page.wait_for_timeout(180);page.mouse.up()
    expect(page.locator('[data-hv-editor]')).to_be_visible()
    expect(page.locator('[data-hv-text]')).to_have_value('今天午餐28.01元，现金')
    assert not calls,'Moving into the edge of Edit must not accidentally send'
    page.locator('[data-hv-close]').click()
    page.evaluate('window.__holdListening=true')
    page.mouse.move(*center(page.locator('#fab')));page.mouse.down();page.wait_for_timeout(550)
    expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','connecting')
    release_at(page,'edit')
    expect(page.locator('[data-hv-editor]')).to_be_visible()
    expect(page.locator('[data-hv-text]')).to_have_value('')
    assert not calls
    page.locator('[data-hv-close]').click();page.evaluate('window.__holdListening=false')
    pending=[]
    page.route('https://short-voice.invalid/**',lambda route:pending.append(route))
    hold(page);release_at(page,'send')
    expect(page.locator('[data-hv-cue]')).to_have_text('正在识别…')
    page.wait_for_timeout(100);assert pending
    page.locator('[data-hv-zone="edit"]').click()
    expect(page.locator('[data-hv-text]')).to_have_value('今天午餐28.01元，现金')
    page.locator('[data-hv-text]').fill('用户中途修改的文字')
    for route in pending:
        try:route.fulfill(json={'choices':[{'message':{'content':'[]'}}]})
        except Exception:pass
    expect(page.locator('[data-hv-text]')).to_have_value('用户中途修改的文字')
    page.locator('[data-hv-close]').click()
    assert state(page)==before and page.evaluate('window.__micCalls')==0
    context.close();print('PASS web fallback, missing native key and permission denial',flush=True)


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        if '--edge-only' not in sys.argv:
            for profile in [(360,760,'light',1,0),(390,844,'light',1,0),(430,932,'dark',1,0),
              (360,560,'light',1.3,32),(400,810,'dark',1.3,32),(1280,900,'light',1,0)]:run(browser,*profile)
        run_unavailable(browser)
        browser.close()
