"""蓝牙路由错误的界面反馈与生命周期；合成原生桥，不验证真实耳机或调用音频服务。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import URL, configure
from test_chat_resume import wait_for_draft
from test_native_live_voice import MOCK as LIVE_MOCK, assert_inline
from test_inbox_hold_voice import setup as short_setup, open_voice, start as short_start, pending
from test_hold_voice import center, preview
from test_refund_layout import state as ledger_state
from test_browser_usability import assert_usable

OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/bluetooth-voice-feedback'
LIVE_MESSAGE='耳机音频未就绪或连接已变化，语音已停止，请确认连接后重新开始'
SHORT_MESSAGE='耳机音频未就绪或连接已变化，请确认耳机连接后重新开始'
PRIVATE='PRIVATE_PROVIDER_ECHO'
PROFILES=[(360,560,'light',1.3),(390,844,'light',1),(430,932,'dark',1),(1280,900,'dark',1.3)]
LIVE_ROUTE=LIVE_MOCK+r'''(()=>{
 const original=window.Capacitor.nativePromise;
 window.__routeStartFailure=true;
 window.Capacitor.nativePromise=async(plugin,method,options={})=>{
   if(plugin==='GleamLiveVoice'&&method==='start'&&window.__routeStartFailure){
     window.__liveCalls.push({method,options});window.__liveSession=options.sessionId;
     const error=new Error('耳机音频未就绪或连接已变化，语音已停止，请确认连接后重新开始');
     error.code='LIVE_AUDIO_ROUTE';error.data={provider:'PRIVATE_PROVIDER_ECHO'};throw error;
   }
   return original(plugin,method,options);
 };
})();'''


def starts(page,live=False):
    return page.evaluate("window."+('__liveCalls' if live else '__voiceCalls')+".filter(c=>c.method==='start').length")


def capture(page,name,profile,selector):
    width,height,theme,scale=profile
    page.locator('#toast.show').wait_for(state='hidden');page.wait_for_timeout(180)
    assert_usable(page,selector)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assert page.evaluate('document.documentElement.dataset.theme')==theme
    OUT.mkdir(parents=True,exist_ok=True)
    page.screenshot(path=str(OUT/f'{name}-{width}-{height}-{theme}-{scale}.png'),animations='disabled')


def live_feedback(browser,profile):
    width,height,theme,scale=profile
    context=browser.new_context(viewport={'width':width,'height':height},service_workers='block',reduced_motion='reduce')
    page=context.new_page();page.add_init_script(LIVE_ROUTE);errors=[];external=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('https://**/*',lambda r:(external.append(r.request.url),r.abort()))
    try:
        page.goto(URL);page.locator('#fab').wait_for();configure(page)
        page.locator('[data-page="page-life"]').click();page.locator('[data-life-chat]').click()
        page.evaluate('([t,s])=>{document.documentElement.dataset.theme=t;document.documentElement.style.setProperty("--seed-type",String(s))}',[theme,scale])
        draft='耳机断开也保留的虚构文字草稿';page.locator('#life-chat-input').fill(draft)
        page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]:enabled').click()
        expect(page.locator('[data-voice-status]')).to_have_text(LIVE_MESSAGE)
        expect(page.locator('[data-voice-start]')).to_be_enabled();assert starts(page,True)==1
        page.wait_for_function('window.__liveListeners.size===0')
        page.wait_for_timeout(120);assert starts(page,True)==1
        # 只有用户主动再点开始才重试；短转写不会触发额外排版请求。
        page.evaluate('window.__routeStartFailure=false');page.locator('[data-voice-start]').click()
        expect(page.locator('[data-voice-mute]')).to_be_visible();assert starts(page,True)==2
        messages=[{'id':'u1','role':'user','content':'保留已经收到的虚构用户转写'},{'id':'a1','role':'assistant','content':'保留已经收到的虚构助手转写。','complete':True}]
        page.evaluate('messages=>{window.__lateLiveCallbacks=[...window.__liveListeners.values()];window.__oldLiveSession=window.__liveSession;window.__liveEvent({state:"listening",messages});}',messages)
        expect(page.locator('#life-chat-messages')).to_contain_text(messages[1]['content'])
        page.evaluate('message=>window.__liveEvent({state:"ended",reason:"LIVE_AUDIO_ROUTE",message})',LIVE_MESSAGE)
        expect(page.locator('[data-voice-status]')).to_have_text(LIVE_MESSAGE)
        expect(page.locator('.chat-voice-overlay')).to_have_attribute('data-voice-state','ended')
        expect(page.locator('[data-voice-start]')).to_be_enabled();page.wait_for_function('window.__liveListeners.size===0')
        assert any(call['method']=='end' for call in page.evaluate('window.__liveCalls'))
        page.evaluate('window.__lateLiveCallbacks.forEach(cb=>cb({sessionId:window.__oldLiveSession,state:"listening",messages:[{role:"assistant",content:"不应出现的迟到转写"}]}))')
        expect(page.locator('[data-voice-status]')).to_have_text(LIVE_MESSAGE)
        expect(page.locator('#life-chat-messages')).not_to_contain_text('不应出现的迟到转写')
        expect(page.locator('.chat-voice-overlay')).to_have_attribute('data-voice-state','ended')
        assert starts(page,True)==2
        assert_inline(page);capture(page,'live-route-ended',profile,'.life-chat-input-wrap')
        assert PRIVATE not in page.locator('body').inner_text()
        page.locator('[data-voice-close]').click();expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        expect(page.locator('#life-chat-input')).to_have_value(draft)
        expect(page.locator('#life-chat-messages')).to_contain_text(messages[0]['content'])
        expect(page.locator('#life-chat-messages')).to_contain_text(messages[1]['content'])
        page.evaluate('window.__lateLiveCallbacks.forEach(cb=>cb({sessionId:window.__oldLiveSession,state:"speaking"}))')
        expect(page.locator('.chat-voice-overlay')).to_have_count(0);assert starts(page,True)==2
        wait_for_draft(page,lambda row: row.get('pendingReply')==draft and all(any(m.get('content')==message['content'] for m in row.get('messages',[])) for message in messages))
        assert page.evaluate('window.__micCalls')==0 and not errors and not external,(errors,external)
        print('PASS live Bluetooth feedback, transcript/draft and stale isolation',profile,flush=True)
    finally:context.close()


def short_feedback(browser,profile):
    width,height,theme,scale=profile
    context,page,errors,requests=short_setup(browser,width,height,theme,scale)
    try:
        before=ledger_state(page);queue=pending(page)
        page.evaluate('''()=>{window.__bluetoothLedgerWrites=[];for(const method of ['add','put','delete','clear']){const original=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){if(['entries','accounts','entryTags','entryAttachments'].includes(this.name))window.__bluetoothLedgerWrites.push({table:this.name,method});return original.apply(this,args);};}window.__voiceError='SPEECH_AUDIO_ROUTE';}''')
        open_voice(page);assert starts(page)==0
        page.mouse.move(*center(page.locator('[data-hv-hold]')));page.mouse.down()
        expect(page.locator('[data-hv-editor]')).to_be_visible();page.mouse.up()
        expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','idle')
        expect(page.locator('[data-hv-message]')).to_have_text(SHORT_MESSAGE)
        assert PRIVATE not in page.locator('body').inner_text()
        assert starts(page)==1;page.wait_for_timeout(120);assert starts(page)==1
        expect(page.locator('[data-hv-send]')).to_be_disabled()
        page.locator('[data-hv-text]').fill('路由失败后仍可手动编辑的虚构文字')
        expect(page.locator('[data-hv-send]')).to_be_enabled()
        assert ledger_state(page)==before and pending(page)==queue and not requests
        # 手动重录不会自动开麦；按住后才发起第二次合成原生请求。
        page.locator('[data-hv-rerecord]').click();assert starts(page)==1
        page.evaluate('window.__voiceError=null');sid=short_start(page)
        partial='耳机断开前已经收到的虚构转写';preview(page,partial)
        page.evaluate('id=>{window.__lateShortCallbacks=[...window.__voiceListeners.values()];window.__oldShortSession=id;window.__voicePending.get(id).reject({code:"SPEECH_AUDIO_ROUTE",message:"PRIVATE_PROVIDER_ECHO",data:{phase:"microphone",actual:"PRIVATE_PROVIDER_ECHO"}})}',sid)
        expect(page.locator('[data-hv-editor]')).to_be_visible();page.mouse.up()
        expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','idle')
        expect(page.locator('[data-hv-message]')).to_have_text(SHORT_MESSAGE)
        expect(page.locator('[data-hv-text]')).to_have_value(partial);page.wait_for_function('window.__voiceListeners.size===0')
        page.evaluate('window.__lateShortCallbacks.forEach(cb=>cb({sessionId:window.__oldShortSession,state:"listening",text:"不应采用的迟到短语音"}))')
        expect(page.locator('[data-hv-text]')).to_have_value(partial);expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','idle');assert starts(page)==2
        capture(page,'short-route-editor',profile,'.hold-voice-stage')
        assert PRIVATE not in page.locator('body').inner_text()
        page.locator('[data-hv-text]').fill('取消前手动编辑仍可保留在本页。')
        page.locator('[data-hv-close]').click();expect(page.locator('.hold-voice-mask')).to_have_count(0)
        expect(page.locator('#ai-text')).to_have_value('保留的虚构收件箱文字')
        page.evaluate('window.__lateShortCallbacks.forEach(cb=>cb({sessionId:window.__oldShortSession,state:"transcribing",text:"不应恢复的已结束短语音"}))')
        expect(page.locator('.hold-voice-mask')).to_have_count(0);assert starts(page)==2
        assert ledger_state(page)==before and pending(page)==queue and not requests
        assert page.evaluate('window.__bluetoothLedgerWrites')==[], '路由失败、编辑和取消不得写入账本'
        assert page.evaluate('window.__micCalls')==0 and not errors,errors
        print('PASS short Bluetooth error, manual edit/cancel and no automatic ledger write',profile,flush=True)
    finally:context.close()


if __name__=='__main__':
    profiles=PROFILES
    if os.environ.get('GLEAM_BLUETOOTH_WIDTH'):profiles=[p for p in profiles if p[0]==int(os.environ['GLEAM_BLUETOOTH_WIDTH'])]
    tests=[short_feedback] if os.environ.get('GLEAM_BLUETOOTH_MODE')=='short' else [live_feedback,short_feedback]
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for profile in profiles:
            for test in tests:test(browser,profile)
        browser.close()
