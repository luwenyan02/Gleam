"""Inbox click enters the shared hold-to-talk flow; synthetic native bridge/model, manual Save only."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_hold_voice import MOCK, URL, center, preview, release_at
from test_short_voice import seed_config
from test_refund_layout import SEED, state
from test_life_ai import read_rows
from test_browser_usability import assert_usable

OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/inbox-hold-voice'
BRIDGE=MOCK+r'''(()=>{const call=window.Capacitor.nativePromise;
 window.Capacitor.nativePromise=async function(plugin,method,options){
 if(plugin==='GleamSpeech'&&method==='stop'&&window.__waitFinal)return {};
 return call.call(this,plugin,method,options);
 };})();'''


def setup(browser,width=390,height=844,theme='light',scale=1,safe=0):
    context=browser.new_context(viewport={'width':width,'height':height},timezone_id='Asia/Shanghai',service_workers='block',reduced_motion='reduce')
    page=context.new_page();page.add_init_script(BRIDGE);errors=[];requests=[]
    page.on('pageerror',lambda e:errors.append(str(e)));page.route('https://**/*',lambda r:r.abort())
    def model(route):
        requests.append(route.request.post_data_json)
        text=requests[-1]['messages'][-1]['content']
        route.fulfill(json={'choices':[{'message':{'content':json.dumps([{'type':'expense',
            'amount':'18.25' if '18.25' in text else '28.01','category':'餐饮/午餐','account':'虚构现金',
            'time':'2026-10-20 12:00','note':'虚构收件箱语音','confidence':100}],ensure_ascii=False)}}]})
    page.route('https://short-voice.invalid/**',model)
    page.goto(URL);page.locator('#fab').wait_for();seed_config(page)
    page.evaluate(SEED.replace('虚构退款账户长名称用于检查布局','虚构现金'))
    page.reload();page.locator('#fab').wait_for()
    page.evaluate('([t,s,b])=>{document.documentElement.dataset.theme=t;document.documentElement.style.setProperty("--seed-type",s);document.documentElement.style.setProperty("--safe-bottom",b+"px")}',[theme,str(scale),safe])
    page.locator('[data-qa="ai"]').click();page.locator('#ai-text').fill('保留的虚构收件箱文字')
    return context,page,errors,requests


def pending(page):
    return next((row['value'] for row in read_rows(page,'settings') if row['key']=='ai.pendingItems'),[])


def open_voice(page):
    page.locator('[data-act="short-voice"]').click()
    expect(page.locator('.hold-voice-mask')).to_be_visible(timeout=2500)
    expect(page.locator('.short-voice-mask')).to_have_count(0)
    expect(page.locator('[data-hv-cue]')).to_have_text('按住说话')


def start(page):
    page.mouse.move(*center(page.locator('[data-hv-hold]')));page.mouse.down()
    expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','listening')
    return page.evaluate("window.__voiceCalls.filter(c=>c.method==='start').at(-1).sessionId")


def run(browser,width,height,theme,scale,safe):
    context,page,errors,requests=setup(browser,width,height,theme,scale,safe)
    try:
        before=state(page);queue=pending(page);OUT.mkdir(parents=True,exist_ok=True)
        def capture(name):
            page.wait_for_timeout(120);assert_usable(page,'.hold-voice-stage')
            page.screenshot(path=str(OUT/f'{name}-{width}-{height}-{theme}-{scale}.png'),animations='disabled')
        open_voice(page)
        assert not any(c['method']=='start' for c in page.evaluate('window.__voiceCalls'))
        capture('ready')
        page.locator('[data-hv-zone="edit"]').click()
        expect(page.locator('[data-hv-text]')).to_have_value('')
        expect(page.locator('[data-hv-send]')).to_be_disabled();assert not requests
        capture('empty-editor')
        page.locator('[data-hv-text]').fill('将被重录清空的文字');page.locator('[data-hv-rerecord]').click()
        sid=start(page);preview(page,'虚构实时文字')
        page.mouse.move(*center(page.locator('[data-hv-zone="cancel"]')))
        expect(page.locator('[data-hv-zone="cancel"]')).to_have_class('selected');capture('cancel')
        release_at(page,'cancel');expect(page.locator('.hold-voice-mask')).to_have_count(0)
        expect(page.locator('[data-act="short-voice"]')).to_be_focused()
        assert state(page)==before and pending(page)==queue and not requests
        open_voice(page);sid=start(page);preview(page,'午餐18.25元现金')
        expect(page.locator('[data-hv-transcript]')).to_have_text('午餐18.25元现金')
        page.mouse.move(*center(page.locator('[data-hv-zone="edit"]')));capture('edit-selected');release_at(page,'edit')
        expect(page.locator('[data-hv-text]')).to_have_value('午餐18.25元现金')
        page.evaluate("id=>window.__voicePending.get(id)?.resolve({sessionId:id,text:'迟到结果'})",sid)
        expect(page.locator('[data-hv-text]')).to_have_value('午餐18.25元现金');assert not requests
        capture('editor')
        page.locator('[data-hv-send]').click();page.locator('#sheet.open').wait_for()
        expect(page.locator('.hold-voice-mask')).to_have_count(0);expect(page.locator('#amt')).to_contain_text('18.25')
        assert state(page)==before and pending(page)==queue and len(requests)==1
        page.locator('#sheet-close').click();expect(page.locator('[data-act="short-voice"]')).to_be_focused()
        expect(page.locator('#ai-text')).to_have_value('保留的虚构收件箱文字')
        open_voice(page);sid=start(page);preview(page,'午餐28.01元现金');page.evaluate('window.__waitFinal=true')
        release_at(page,'send');expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','transcribing')
        page.locator('[data-hv-zone="edit"]').click();expect(page.locator('[data-hv-text]')).to_have_value('午餐28.01元现金')
        assert len(requests)==1
        page.locator('[data-hv-rerecord]').click();expect(page.locator('[data-hv-text]')).to_have_value('')
        page.evaluate('window.__waitFinal=false');start(page);preview(page,'午餐28.01元现金');release_at(page,'send')
        page.locator('#sheet.open').wait_for();expect(page.locator('#amt')).to_contain_text('28.01')
        assert state(page)==before and pending(page)==queue and len(requests)==2
        page.locator('#keypad [data-k="save"]').click();page.locator('#sheet.open').wait_for(state='hidden')
        entries=read_rows(page,'entries');assert len(entries)==len(before['entries'])+1
        assert entries[-1]['amount']==2801 and pending(page)==queue
        expect(page.locator('#ai-text')).to_have_value('保留的虚构收件箱文字')
        expect(page.locator('[data-act="short-voice"]')).to_be_focused()
        open_voice(page);page.go_back();expect(page.locator('.hold-voice-mask')).to_have_count(0)
        expect(page.locator('#sp-ai-inbox')).to_be_visible();expect(page.locator('[data-act="short-voice"]')).to_be_focused()
        assert page.evaluate('window.__micCalls')==0 and not errors,errors
        print('PASS inbox shared voice gestures, edit, rerecord, handoff and manual Save',width,height,theme,scale,flush=True)
    finally:context.close()


if __name__=='__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for profile in [(360,760,'light',1,0),(390,844,'light',1,0),(430,932,'dark',1,0),
                        (360,560,'light',1.3,32),(400,810,'dark',1.3,32),(1280,900,'light',1,0)]:run(browser,*profile)
        browser.close()
