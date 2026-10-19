"""Slow native readiness/ASR and draft data: editable, cancelable, no late opens or writes."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_hold_voice import MOCK, hold, preview, release_at, center
from test_short_voice import seed_config
from test_refund_layout import SEED, state

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4617/')
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/hold-voice-handoff'
BRIDGE=MOCK+r'''(()=>{const original=window.Capacitor.nativePromise;
 window.Capacitor.nativePromise=async function(plugin,method,options){
  if(plugin==='GleamSpeech'&&method==='stop'&&window.__waitFinal)return {};
  return original.call(this,plugin,method,options);
 };})();'''


def setup(browser):
    context=browser.new_context(viewport={'width':390,'height':844},service_workers='block')
    page=context.new_page();page.add_init_script(BRIDGE);errors=[];requests=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('https://**/*',lambda route:route.abort())
    def model(route):
        requests.append(route.request.post_data_json)
        route.fulfill(json={'choices':[{'message':{'content':json.dumps([{'type':'expense','amount':'28.01',
          'category':'餐饮/午餐','account':'虚构现金','time':'2026-10-20 12:00','note':'虚构交接草稿','confidence':100}],ensure_ascii=False)}}]})
    page.route('https://short-voice.invalid/**',model)
    page.goto(URL);page.locator('#fab').wait_for();seed_config(page)
    page.evaluate(SEED.replace('虚构退款账户长名称用于检查布局','虚构现金'))
    page.reload();page.locator('#fab').wait_for()
    return context,page,errors,requests


def gate(page):
    # A real read-write transaction holds draft history reads; it never changes any row.
    page.evaluate('''async()=>{
     const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
     window.__releaseDraft=false;
     const tx=db.transaction('entries','readwrite'),store=tx.objectStore('entries');
     const pump=()=>{const r=store.get(8101);r.onsuccess=()=>{if(!window.__releaseDraft)pump()}};
     pump();tx.oncomplete=()=>db.close();}''')


def preparing(browser):
    context,page,errors,requests=setup(browser)
    try:
        before=state(page)
        page.evaluate('window.__holdNextConfiguration=true')
        page.mouse.move(*center(page.locator('#fab')));page.mouse.down()
        page.locator('.hold-voice-mask').wait_for();page.wait_for_timeout(150)
        expect(page.locator('[data-hv-status]')).to_have_text('正在准备语音…')
        expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','preparing')
        page.screenshot(path=str(OUT/'preparing.png'),animations='disabled')
        release_at(page,'edit');expect(page.locator('[data-hv-text]')).to_have_value('')
        page.locator('[data-hv-text]').fill('手动文字')
        page.evaluate('window.__finishConfiguration()');page.wait_for_timeout(100)
        expect(page.locator('[data-hv-text]')).to_have_value('手动文字')
        assert not any(c['method']=='start' for c in page.evaluate('window.__voiceCalls'))
        page.locator('[data-hv-close]').click();assert not requests and state(page)==before
        assert not errors,errors
    finally:context.close()


def transcribing(browser):
    context,page,errors,requests=setup(browser)
    try:
        before=state(page);page.evaluate('window.__waitFinal=true')
        for text in ['', '虚构午餐28元']:
            sid=hold(page);preview(page,text);release_at(page,'send')
            expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','transcribing')
            page.locator('[data-hv-zone="edit"]').click()
            expect(page.locator('[data-hv-editor]')).to_be_visible()
            expect(page.locator('[data-hv-text]')).to_have_value(text)
            page.locator('[data-hv-text]').fill('用户修改的文字')
            page.evaluate("id=>window.__voicePending.get(id).resolve({sessionId:id,text:'迟到最终结果'})",sid)
            page.wait_for_timeout(100)
            expect(page.locator('[data-hv-text]')).to_have_value('用户修改的文字')
            assert not requests
            page.locator('[data-hv-close]').click()
        assert state(page)==before and not errors,errors
    finally:context.close()


def handoff(browser):
    context,page,errors,requests=setup(browser)
    try:
        before=state(page)
        for action in ['back','edit','open']:
            gate(page);hold(page);preview(page,'虚构午餐28元');release_at(page,'send')
            expect(page.locator('[data-hv-status]')).to_have_text('正在打开草稿…')
            expect(page.locator('.hold-voice-mask')).to_be_visible()
            expect(page.locator('#sheet.open')).to_have_count(0)
            if action=='back':page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))')
            if action=='edit':
                page.locator('[data-hv-zone="edit"]').click()
                expect(page.locator('[data-hv-text]')).to_have_value('今天午餐28.01元，现金')
                page.locator('[data-hv-text]').fill('准备期间用户手改')
            if action=='open':
                page.evaluate('''()=>{window.__handoffGap=0;window.__checkingHandoff=true;
                 const frame=()=>{if(!window.__checkingHandoff)return;
                  const mask=document.getElementsByClassName('hold-voice-mask')[0];
                  const sheet=document.getElementById('sheet').classList.contains('open');
                  if(!mask&&!sheet)window.__handoffGap++;
                  if(sheet){window.__checkingHandoff=false;return;}requestAnimationFrame(frame)};frame();}''')
                page.screenshot(path=str(OUT/'opening-draft.png'),animations='disabled')
            page.evaluate('window.__releaseDraft=true');page.wait_for_timeout(200)
            if action=='open':
                page.locator('#keypad').wait_for();expect(page.locator('#amt')).to_have_text('28.01')
                assert page.evaluate('window.__handoffGap')==0
                expect(page.locator('#keypad [data-k="save"]')).to_be_enabled()
                page.locator('#sheet-close').click()
                expect(page.locator('#fab')).to_be_focused()
            else:
                expect(page.locator('#sheet.open')).to_have_count(0)
                if action=='edit':
                    expect(page.locator('[data-hv-text]')).to_have_value('准备期间用户手改')
                    page.locator('[data-hv-close]').click()
            assert state(page)==before,'Preparing a voice draft must not persist a ledger entry'
        # A draft-data failure preserves editable text and does not open an empty form.
        page.evaluate('''()=>{const get=IDBObjectStore.prototype.get;
         IDBObjectStore.prototype.get=function(key){if(key==='entry.lastUsed')throw new DOMException('synthetic read error','AbortError');return get.call(this,key)}}''')
        hold(page);release_at(page,'send')
        expect(page.locator('[data-hv-editor]')).to_be_visible()
        expect(page.locator('[data-hv-text]')).to_have_value('今天午餐28.01元，现金')
        expect(page.locator('[data-hv-message]')).to_contain_text('草稿')
        assert len(requests)==4 and not errors,errors
        assert page.evaluate('window.__micCalls')==0
    finally:
        page.evaluate('window.__releaseDraft=true');context.close()


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True);failed=[]
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for case in [preparing,transcribing,handoff]:
            try:case(browser);print('PASS',case.__name__,flush=True)
            except Exception as error:failed.append(case.__name__);print('FAIL',case.__name__,str(error),flush=True)
        browser.close()
    assert not failed,failed
