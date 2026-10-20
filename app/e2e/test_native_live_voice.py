"""Android 双向语音面板：合成原生桥，无真实麦克风、音频或付费请求。"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import URL, configure
from test_short_voice import MOCK_NATIVE
from test_browser_usability import assert_usable

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/native-live-voice'
MOCK = MOCK_NATIVE + r''';(() => {
 const original=window.Capacitor.nativePromise, callback=window.Capacitor.nativeCallback; window.__liveCalls=[]; window.__liveReady=true;window.__liveListeners=new Map();
 window.Capacitor.PluginHeaders.push({name:'GleamLiveVoice',methods:[...['configuration','start','mute','interrupt','end'].map(name=>({name,rtype:'promise'})),...['addListener','removeListener'].map(name=>({name,rtype:'callback'}))]});
 window.Capacitor.nativeCallback=(plugin,method,options,fn)=>{
  if(plugin!=='GleamLiveVoice')return callback(plugin,method,options,fn);
  window.__liveCalls.push({method,options});
  if(method==='addListener'){const id='live-'+crypto.randomUUID();window.__liveListeners.set(id,fn);return id;}
  if(method==='removeListener')window.__liveListeners.delete(options.callbackId);
  return 'live-removed';
 };
 window.Capacitor.nativePromise=async (plugin,method,options={})=>{
  if(plugin!=='GleamLiveVoice')return original(plugin,method,options);
  window.__liveCalls.push({method,options});
  if(method==='configuration')return {ready:window.__liveReady,credentialRevision:'verified-live-revision'};
  if(method==='addListener')return {};
  if(method==='start'){
   if(window.__liveDeny)throw Object.assign(new Error('请允许使用麦克风后重试'),{code:'LIVE_PERMISSION_DENIED'});
   window.__liveSession=options.sessionId;
   if(window.__livePending)return new Promise(resolve=>{window.__resolveLiveStart=()=>resolve({sessionId:options.sessionId});});
   return {sessionId:options.sessionId};
  }
  return {};
 };
 window.__liveEvent=data=>{
  if(!window.__liveListeners.size)throw new Error('No live listener');
  for(const fn of window.__liveListeners.values())fn({sessionId:window.__liveSession,...data});
 };
})();'''


def run(browser,width,height,theme,scale):
    context=browser.new_context(viewport={'width':width,'height':height},service_workers='block',reduced_motion='reduce',timezone_id='Asia/Shanghai')
    page=context.new_page();page.add_init_script(MOCK);errors=[];external=[]
    page.on('pageerror',lambda e:errors.append(str(e)));page.route('https://**/*',lambda r:(external.append(r.request.url),r.abort()))
    try:
        page.goto(URL);page.locator('#fab').wait_for();configure(page)
        page.locator('[data-page="page-life"]').click();page.locator('[data-life-chat]').click()
        page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",scale)}',[theme,str(scale)])
        page.locator('#life-chat-input').fill('保留的虚构文字草稿')
        page.locator('[data-chat-voice]').click()
        expect(page.locator('[data-voice-start]')).to_be_enabled()
        expect(page.locator('#voice-workspace,[data-voice-model],[data-voice-region]')).to_have_count(0)
        assert page.locator('[data-voice-close]').evaluate('el=>{const r=el.getBoundingClientRect();return r.width===44&&r.height===44&&getComputedStyle(el).borderRadius==="50%"}')
        assert not any(c['method']=='start' for c in page.evaluate('window.__liveCalls'))
        assert page.evaluate('window.__micCalls')==0
        OUT.mkdir(parents=True,exist_ok=True)
        assert_usable(page,'#sheet');page.screenshot(path=str(OUT/f'ready-{width}-{theme}-{scale}.png'),animations='disabled')
        page.locator('[data-voice-start]').click()
        page.wait_for_function("window.__liveCalls.some(c=>c.method==='start')")
        expect(page.locator('.voice-controls')).to_be_visible()
        expect(page.locator('[data-voice-end]')).to_be_visible()
        calls=page.evaluate('window.__liveCalls');start=next(c for c in calls if c['method']=='start')['options']
        assert start['expectedCredentialRevision']=='verified-live-revision' and start['consent'] and start['userInitiated']
        assert not any(k in start for k in ['key','apiKey','workspace','region','messages','photos'])
        assert '保留的虚构文字草稿' not in json.dumps(start,ensure_ascii=False)
        page.evaluate("window.__liveEvent({state:'speaking'})")
        expect(page.locator('[data-voice-status]')).to_contain_text('拾光在说话')
        page.evaluate("window.__liveEvent({state:'speaking',messages:[{role:'user',content:'你好'},{role:'assistant',content:'你好，有什么想聊的？'}]})")
        expect(page.locator('[data-voice-transcript]')).to_contain_text('你好，有什么想聊的？')
        assert_usable(page,'#sheet');page.screenshot(path=str(OUT/f'connected-{width}-{theme}-{scale}.png'),animations='disabled')
        page.evaluate("window.__liveEvent({state:'speaking',messages:[{role:'assistant',content:('很长的虚构语音回复，用于检查阅读和操作。'+ 'unbroken'.repeat(20)).repeat(12)}]})")
        assert_usable(page,'#sheet')
        assert page.locator('[data-voice-end]').evaluate('el=>{const r=el.getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0}')
        page.screenshot(path=str(OUT/f'long-{width}-{theme}-{scale}.png'),animations='disabled')
        page.evaluate("window.__liveEvent({state:'speaking',messages:[{role:'user',content:'你好'},{role:'assistant',content:'你好，有什么想聊的？'}]})")
        page.locator('[data-voice-mute]').click();expect(page.locator('[data-voice-mute]')).to_have_attribute('aria-pressed','true')
        page.locator('[data-voice-interrupt]').click()
        assert any(c['method']=='interrupt' for c in page.evaluate('window.__liveCalls'))
        page.locator('[data-voice-end]').click();expect(page.locator('[data-voice-start]')).to_be_visible()
        assert any(c['method']=='end' for c in page.evaluate('window.__liveCalls'))
        # 旧会话事件不覆盖新一轮，后台/返回均停止且不会自动重连。
        old=page.evaluate('window.__liveSession');page.locator('[data-voice-start]').click()
        page.wait_for_function('old=>window.__liveSession!==old',arg=old)
        expect(page.locator('.voice-controls')).to_be_visible()
        page.evaluate("id=>window.__liveEvent({sessionId:id,state:'speaking',messages:[{role:'assistant',content:'迟到文字'}]})",old)
        expect(page.locator('[data-voice-transcript]')).not_to_contain_text('迟到文字')
        page.evaluate("window.__liveEvent({state:'ended',reason:'background'})")
        expect(page.locator('[data-voice-status]')).to_contain_text('已结束')
        count=len([c for c in page.evaluate('window.__liveCalls') if c['method']=='start'])
        page.evaluate('document.dispatchEvent(new Event("visibilitychange"))')
        assert len([c for c in page.evaluate('window.__liveCalls') if c['method']=='start'])==count
        page.locator('[data-voice-close]').click();expect(page.locator('#sheet.open')).to_have_count(0)
        expect(page.locator('#life-chat-input')).to_have_value('保留的虚构文字草稿')
        expect(page.locator('.assistant .chat-message-text')).to_contain_text('你好，有什么想聊的？')
        # 权限拒绝可以重试，不显示底层配置；连接准备中也可退出并隔离迟到完成。
        page.evaluate('window.__liveDeny=true');page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]').click()
        expect(page.locator('[data-voice-status]')).to_contain_text('麦克风')
        page.locator('[data-voice-close]').click();page.evaluate('window.__liveDeny=false;window.__livePending=true')
        page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]').click()
        page.wait_for_function('!!window.__resolveLiveStart');page.locator('[data-voice-close]').click();page.evaluate('window.__resolveLiveStart()')
        expect(page.locator('#sheet.open')).to_have_count(0)
        # 真正的页面隐藏也结束；返回前台不自动重新录音。
        page.evaluate('window.__livePending=false');page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]').click()
        expect(page.locator('.voice-controls')).to_be_visible()
        page.evaluate('Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});document.dispatchEvent(new Event("visibilitychange"))')
        expect(page.locator('[data-voice-status]')).to_contain_text('已结束')
        page.evaluate('delete document.hidden;document.dispatchEvent(new Event("visibilitychange"))')
        expect(page.locator('[data-voice-start]')).to_be_visible()
        page.locator('[data-voice-close]').click()
        # 未验证配置只给设置入口，不出现重复配置表单或开始采集。
        page.evaluate('window.__liveReady=false');count=len([c for c in page.evaluate('window.__liveCalls') if c['method']=='start'])
        page.locator('[data-chat-voice]').click();expect(page.locator('[data-voice-settings]')).to_be_visible()
        expect(page.locator('[data-voice-start]')).to_be_hidden()
        assert len([c for c in page.evaluate('window.__liveCalls') if c['method']=='start'])==count
        page.locator('[data-voice-close]').click()
        assert not external and not errors,(external,errors)
        print('PASS native live voice shared configuration, controls, transcript, background and stale isolation',width,theme,scale,flush=True)
    finally:context.close()


if __name__=='__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for profile in [(360,760,'light',1),(390,844,'light',1),(430,932,'dark',1),(360,560,'light',1.3),(400,810,'dark',1.3),(1280,900,'light',1)]:run(browser,*profile)
        browser.close()
