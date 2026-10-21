"""Android 双向语音面板：合成原生桥，无真实麦克风、音频或付费请求。"""
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import URL, configure, read_rows
from test_short_voice import MOCK_NATIVE
from test_browser_usability import assert_usable
from native_ai_stream_mock import MOCK as AI_STREAM_MOCK

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/inline-live-voice'
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
   window.__liveSession=options.sessionId;window.__liveMuted=false;
   if(window.__livePending)return new Promise(resolve=>{window.__resolveLiveStart=()=>resolve({sessionId:options.sessionId});});
   return {sessionId:options.sessionId};
  }
  if(method==='mute'){window.__liveMuted=options.muted;window.__liveEvent({state:options.muted?'muted':'listening'});}
  if(method==='interrupt')window.__liveEvent({state:window.__liveMuted?'muted':'listening'});
  return {};
 };
 window.__liveEvent=data=>{
  if(!window.__liveListeners.size)throw new Error('No live listener');
  for(const fn of window.__liveListeners.values())fn({sessionId:window.__liveSession,...data});
 };
})();''' + AI_STREAM_MOCK


def assert_inline(page):
    page.wait_for_function("document.querySelector('.chat-voice-overlay').getAnimations().every(a=>a.playState==='finished')")
    assert page.locator('.chat-voice-overlay').evaluate(r'''el=>{
      const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();
      const messages=document.querySelector('#life-chat-messages');
      const alpha=getComputedStyle(el).backgroundColor.match(/[,/]\s*([\d.]+)\s*\)$/);
      return Math.abs(r.left-p.left-1)<1.1&&Math.abs(r.right-p.right+1)<1.1&&r.top>=p.top&&r.bottom<=p.bottom
        &&r.bottom<=innerHeight&&r.top>=messages.getBoundingClientRect().bottom-1&&!messages.closest('[inert]')
        &&!el.hasAttribute('aria-modal')&&getComputedStyle(el).backdropFilter.includes('blur')&&alpha&&Number(alpha[1])<1;
    }''')
    assert_usable(page,'.chat-voice-overlay')
    assert page.locator('.life-chat-page').evaluate('el=>el.scrollHeight<=el.clientHeight+1')
    assert page.locator('#sp-life-chat .sub-head').bounding_box()['y']>=0


def run(browser,width,height,theme,scale):
    context=browser.new_context(viewport={'width':width,'height':height},service_workers='block',reduced_motion='no-preference' if width==390 else 'reduce',timezone_id='Asia/Shanghai')
    page=context.new_page();page.add_init_script(MOCK);errors=[];external=[]
    page.on('pageerror',lambda e:errors.append(str(e)));page.route('https://**/*',lambda r:(external.append(r.request.url),r.abort()))
    try:
        page.goto(URL);page.locator('#fab').wait_for();configure(page)
        page.locator('[data-page="page-life"]').click();page.locator('[data-life-chat]').click()
        page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",scale)}',[theme,str(scale)])
        draft = '保留的虚构文字草稿\n' * 10 if width == 390 else '保留的虚构文字草稿'
        page.locator('#life-chat-input').fill(draft)
        page.locator('[data-chat-voice]').click()
        # 语音层仅覆盖输入区，聊天记录保持可读且没有全页抽屉。
        expect(page.locator('.life-chat-input-wrap .chat-voice-overlay')).to_be_visible()
        expect(page.locator('#sheet.open,#scrim.show')).to_have_count(0)
        expect(page.locator('[data-voice-start]')).to_be_enabled()
        expect(page.locator('#voice-workspace,[data-voice-model],[data-voice-region]')).to_have_count(0)
        assert page.locator('[data-voice-close]').evaluate('el=>{const face=el.querySelector(".voice-control-face"),r=face.getBoundingClientRect();return r.width>=44&&r.width===r.height&&getComputedStyle(face).borderRadius==="50%"}')
        assert not any(c['method']=='start' for c in page.evaluate('window.__liveCalls'))
        assert page.evaluate('window.__micCalls')==0
        assert_inline(page)
        OUT.mkdir(parents=True,exist_ok=True)
        assert_usable(page,'#sp-life-chat');page.screenshot(path=str(OUT/f'ready-{width}-{theme}-{scale}.png'),animations='disabled')
        page.locator('[data-voice-start]').click()
        page.wait_for_function("window.__liveCalls.some(c=>c.method==='start')")
        expect(page.locator('[data-voice-mute]')).to_be_visible()
        expect(page.locator('[data-voice-end]')).to_be_visible()
        calls=page.evaluate('window.__liveCalls');start=next(c for c in calls if c['method']=='start')['options']
        assert start['expectedCredentialRevision']=='verified-live-revision' and start['consent'] and start['userInitiated']
        assert not any(k in start for k in ['key','apiKey','workspace','region','messages','photos'])
        assert '保留的虚构文字草稿' not in json.dumps(start,ensure_ascii=False)
        page.evaluate("window.__liveEvent({state:'listening',messages:[{role:'user',content:'你'}]})")
        expect(page.locator('.user .chat-message-text')).to_have_count(1)
        page.evaluate("window.__liveEvent({state:'listening',messages:[{role:'user',content:'你好'}]})")
        expect(page.locator('.user .chat-message-text')).to_have_text('你好')
        page.evaluate("window.__liveEvent({state:'speaking'})")
        expect(page.locator('[data-voice-status]')).to_contain_text('拾光在说话')
        page.evaluate("window.__liveEvent({state:'speaking',messages:[{role:'user',content:'你好'},{role:'assistant',content:'你好，有什么想聊的？'}]})")
        expect(page.locator('#life-chat-messages')).to_contain_text('你好，有什么想聊的？')
        expect(page.locator('.assistant .chat-message-text')).to_have_count(1)
        expect(page.locator('[data-voice-transcript]')).to_have_count(0)
        expect(page.locator('.chat-voice-overlay')).to_have_attribute('data-voice-state','speaking')
        # 选中的语音条：圆形侧控、中央胶囊；动效遵从系统减少动态设置。
        assert page.locator('[data-voice-mute]').evaluate('el=>{const r=el.querySelector(".voice-control-face").getBoundingClientRect();return r.width>=44&&Math.abs(r.width-r.height)<1}')
        assert page.locator('[data-voice-interrupt]').evaluate('el=>{const r=el.querySelector(".voice-control-face").getBoundingClientRect();return r.width>r.height*1.7}')
        assert page.locator('.voice-wave:visible').evaluate('el=>el.getAnimations({subtree:true}).length>0') == (width==390)
        expect(page.locator('[data-voice-close]')).to_be_hidden()
        expect(page.locator('[data-voice-interrupt]')).to_have_accessible_name('打断回复')
        assert_inline(page)
        expect(page.locator('[data-chat-start]')).to_be_disabled()
        expect(page.locator('[data-chat-regenerate]')).to_be_disabled()
        expect(page.locator('[data-chat-copy]')).to_be_enabled()
        assert_usable(page,'#sp-life-chat');page.screenshot(path=str(OUT/f'connected-{width}-{theme}-{scale}.png'),animations='disabled')
        page.evaluate("window.__liveEvent({state:'speaking',messages:[{role:'assistant',content:('很长的虚构语音回复，用于检查阅读和操作。'+ 'unbroken'.repeat(20)).repeat(12)}]})")
        assert_usable(page,'#sp-life-chat')
        assert page.locator('[data-voice-end]').evaluate('el=>{const r=el.getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0}')
        page.screenshot(path=str(OUT/f'long-{width}-{theme}-{scale}.png'),animations='disabled')
        # 阅读旧消息时仍可收到转录，但不强制滚到底部。
        page.evaluate("window.__readingMessages=Array.from({length:30},(_,i)=>({role:i%2?'assistant':'user',content:'虚构聊天 '+i+'：'+('用于检查阅读位置。'.repeat(8))}));window.__liveEvent({state:'speaking',messages:window.__readingMessages})")
        expect(page.locator('.life-chat-bubble')).to_have_count(30)
        page.locator('#life-chat-messages').evaluate('el=>el.scrollTop=0')
        page.evaluate("window.__readingMessages[29].content+='新的实时转录';window.__liveEvent({state:'speaking',messages:window.__readingMessages})")
        expect(page.locator('.assistant .chat-message-text').last).to_contain_text('新的实时转录')
        assert page.locator('#life-chat-messages').evaluate('el=>el.scrollTop')<2
        page.evaluate("window.__liveEvent({state:'speaking',messages:[{role:'user',content:'你好'},{role:'assistant',content:'你好，有什么想聊的？'}]})")
        page.locator('[data-voice-mute]').click();expect(page.locator('[data-voice-mute]')).to_have_attribute('aria-pressed','true')
        expect(page.locator('.chat-voice-overlay')).to_have_attribute('data-voice-state','muted')
        assert page.locator('.voice-wave:visible').evaluate('el=>el.getAnimations({subtree:true}).filter(a=>a instanceof CSSAnimation).length')==0
        expect(page.locator('[data-voice-mic-off]')).to_be_visible()
        # 静音期间即使收到回复状态也不伪装成正在采集；取消静音恢复原图标和动效。
        page.evaluate("window.__liveEvent({state:'speaking'})")
        assert page.locator('.voice-wave:visible').evaluate('el=>el.getAnimations({subtree:true}).filter(a=>a instanceof CSSAnimation).length')==0
        page.locator('[data-voice-mute]').click()
        expect(page.locator('[data-voice-mute]')).to_have_attribute('aria-pressed','false')
        expect(page.locator('[data-voice-mic-on]')).to_be_visible()
        expect(page.locator('[data-voice-mic-off]')).to_be_hidden()
        page.locator('[data-voice-mute]').click()
        page.locator('[data-voice-interrupt]').click()
        assert any(c['method']=='interrupt' for c in page.evaluate('window.__liveCalls'))
        page.locator('[data-voice-end]').click();expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        page.locator('[data-chat-voice]').click();expect(page.locator('[data-voice-start]')).to_be_enabled()
        assert any(c['method']=='end' for c in page.evaluate('window.__liveCalls'))
        # 旧会话事件不覆盖新一轮，后台/返回均停止且不会自动重连。
        old=page.evaluate('window.__liveSession');page.locator('[data-voice-start]').click()
        page.wait_for_function('old=>window.__liveSession!==old',arg=old)
        expect(page.locator('[data-voice-mute]')).to_be_visible()
        page.evaluate("id=>window.__liveEvent({sessionId:id,state:'speaking',messages:[{role:'assistant',content:'迟到文字'}]})",old)
        expect(page.locator('#life-chat-messages')).not_to_contain_text('迟到文字')
        page.evaluate("window.__liveEvent({state:'ended',reason:'background'})")
        expect(page.locator('[data-voice-status]')).to_contain_text('已结束')
        count=len([c for c in page.evaluate('window.__liveCalls') if c['method']=='start'])
        page.evaluate('document.dispatchEvent(new Event("visibilitychange"))')
        assert len([c for c in page.evaluate('window.__liveCalls') if c['method']=='start'])==count
        page.locator('[data-voice-close]').click();expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        expect(page.locator('#life-chat-input')).to_have_value(draft)
        expect(page.locator('.assistant .chat-message-text')).to_contain_text('你好，有什么想聊的？')
        # 权限拒绝可以重试，不显示底层配置；连接准备中也可退出并隔离迟到完成。
        page.evaluate('window.__liveDeny=true');page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]').click()
        expect(page.locator('[data-voice-status]')).to_contain_text('麦克风')
        page.locator('[data-voice-close]').click();page.evaluate('window.__liveDeny=false;window.__livePending=true')
        page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]').click()
        page.wait_for_function('!!window.__resolveLiveStart');expect(page.locator('[data-voice-end]')).to_have_accessible_name('取消连接');page.locator('[data-voice-end]').click();page.evaluate('window.__resolveLiveStart()')
        expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        # 真正的页面隐藏也结束；返回前台不自动重新录音。
        page.evaluate('window.__livePending=false');page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]').click()
        expect(page.locator('[data-voice-mute]')).to_be_visible()
        page.evaluate('Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});document.dispatchEvent(new Event("visibilitychange"))')
        expect(page.locator('[data-voice-status]')).to_contain_text('已结束')
        page.evaluate('delete document.hidden;document.dispatchEvent(new Event("visibilitychange"))')
        expect(page.locator('[data-voice-start]')).to_be_visible()
        page.locator('[data-voice-close]').click()
        # 键盘、Android返回、浏览器返回只关闭语音层，前进不重新开始；同一帧退出保留最后转录。
        page.evaluate('window.__liveReady=true')
        page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]').click()
        expect(page.locator('[data-voice-mute]')).to_be_visible();page.keyboard.press('Escape')
        expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        expect(page.locator('#sp-life-chat')).to_be_visible()
        expect(page.locator('[data-chat-voice]')).to_be_focused()
        page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]').click()
        expect(page.locator('[data-voice-mute]')).to_be_visible()
        page.evaluate('''window.__liveEvent({state:'speaking',messages:[{role:'user',content:'退出前的最后一句'}]});document.dispatchEvent(new CustomEvent('gleam:system-back'))''')
        expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        expect(page.locator('#life-chat-messages')).to_contain_text('退出前的最后一句')
        page.locator('[data-chat-voice]').click();expect(page.locator('[data-voice-start]')).to_be_enabled()
        page.go_back();expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        page.go_forward();expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        expect(page.locator('#sp-life-chat')).to_be_visible()
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            rows=read_rows(page,'lifeDrafts')
            if any(any(m.get('content')=='退出前的最后一句' for m in row.get('messages',[])) for row in rows):break
            page.wait_for_timeout(50)
        else:raise AssertionError('Last voice transcript was not persisted')
        page.reload();page.locator('#fab').wait_for();page.locator('[data-page="page-life"]').click();page.locator('[data-life-chat]').click()
        expect(page.locator('#life-chat-messages')).to_contain_text('退出前的最后一句')
        expect(page.locator('#life-chat-input')).to_have_value(draft)
        expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        # 未验证配置只给设置入口，不出现重复配置表单或开始采集。
        page.evaluate('window.__liveReady=false');count=len([c for c in page.evaluate('window.__liveCalls') if c['method']=='start'])
        page.locator('[data-chat-voice]').click();expect(page.locator('[data-voice-settings]')).to_be_visible()
        expect(page.locator('[data-voice-start]')).to_be_hidden()
        assert len([c for c in page.evaluate('window.__liveCalls') if c['method']=='start'])==count
        page.locator('[data-voice-close]').click()
        assert not external and not errors,(external,errors)
        print('PASS native live voice shared configuration, controls, transcript, background and stale isolation',width,theme,scale,flush=True)
    finally:context.close()


def run_geometry(browser, width, height, theme, scale):
    context=browser.new_context(viewport={'width':width,'height':height},service_workers='block',reduced_motion='reduce')
    page=context.new_page();page.add_init_script(MOCK);errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('https://**/*',lambda r:r.abort())
    try:
        page.goto(URL);page.locator('#fab').wait_for();configure(page)
        page.locator('[data-page="page-life"]').click();page.locator('[data-life-chat]').click()
        page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",scale)}',[theme,str(scale)])
        page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]').click()
        expect(page.locator('[data-voice-mute]')).to_be_visible()
        page.evaluate("window.__liveEvent({state:'listening',messages:Array.from({length:24},(_,i)=>({role:i%2?'assistant':'user',content:'虚构历史 '+i+'。'+ '保留阅读位置。'.repeat(12)}))})")
        expect(page.locator('.life-chat-bubble')).to_have_count(24)
        page.locator('[data-voice-end]').click();expect(page.locator('[data-chat-voice]')).to_be_enabled()
        def layout():
            return page.evaluate("""()=>{const m=document.querySelector('#life-chat-messages'),c=document.querySelector('.life-chat-input-wrap');return {top:m.getBoundingClientRect().top,bottom:m.getBoundingClientRect().bottom,scroll:m.scrollTop,composer:c.getBoundingClientRect().height,first:m.querySelector('.life-chat-bubble').getBoundingClientRect().top}}""")
        for draft in ['', '保留多行草稿\n'*10]:
            page.locator('#life-chat-input').fill(draft)
            page.locator('#life-chat-messages').evaluate('el=>el.scrollTop=240')
            baseline=layout()
            OUT.mkdir(parents=True,exist_ok=True)
            if not draft:page.screenshot(path=str(OUT/f'compact-before-{width}-{theme}-{scale}.png'),animations='disabled')
            def unchanged(state):
                actual=layout()
                assert all(abs(actual[k]-v)<1 for k,v in baseline.items()),(state,baseline,actual)
                if page.locator('.chat-voice-overlay').count():
                    assert_inline(page)
                    assert page.locator('.chat-voice-overlay').evaluate("el=>[...el.querySelectorAll('button')].filter(b=>b.getClientRects().length).every(b=>{const a=el.getBoundingClientRect(),r=b.getBoundingClientRect();return r.top>=a.top&&r.bottom<=a.bottom+1})")
            page.evaluate('window.__livePending=true;window.__resolveLiveStart=null')
            page.locator('[data-chat-voice]').click();expect(page.locator('[data-voice-start]')).to_be_enabled();unchanged('idle')
            expect(page.locator('.voice-consent')).to_have_count(0)
            if not draft:page.screenshot(path=str(OUT/f'compact-idle-{width}-{theme}-{scale}.png'),animations='disabled')
            page.locator('[data-voice-start]').click();page.wait_for_function('!!window.__resolveLiveStart');unchanged('connecting')
            page.evaluate('window.__resolveLiveStart()');expect(page.locator('[data-voice-mute]')).to_be_visible();unchanged('listening')
            page.evaluate("window.__liveEvent({state:'speaking'})");unchanged('speaking')
            page.mouse.move(0,0);OUT.mkdir(parents=True,exist_ok=True)
            page.screenshot(path=str(OUT/f'compact-{width}-{theme}-{scale}-{"draft" if draft else "empty"}.png'),animations='disabled')
            page.locator('[data-voice-mute]').click();unchanged('muted')
            page.locator('[data-voice-interrupt]').click();unchanged('interrupted')
            page.evaluate("window.__liveEvent({state:'ended',message:'耳机音频未就绪或连接已变化，语音已停止，请确认连接后重新开始'})")
            expect(page.locator('[data-voice-start]')).to_be_enabled();unchanged('error')
            if not draft:page.screenshot(path=str(OUT/f'compact-error-{width}-{theme}-{scale}.png'),animations='disabled')
            page.locator('[data-voice-close]').click();expect(page.locator('[data-chat-voice]')).to_be_enabled();unchanged('closed')
            expect(page.locator('#life-chat-input')).to_have_value(draft)
        assert not errors,errors
        print('PASS voice dock fixed composer geometry and scroll',width,theme,scale,flush=True)
    finally:context.close()


def run_web_playback(browser):
    context=browser.new_context(viewport={'width':360,'height':760},service_workers='block',reduced_motion='reduce')
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script("""(()=>{
      const track={enabled:false,stop(){}};
      navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]});
      HTMLMediaElement.prototype.play=async()=>{if(!window.__allowPlayback)throw new Error('synthetic autoplay block')};
      window.RTCPeerConnection=class extends EventTarget{
        constructor(){super();window.__pc=this;this.iceGatheringState='complete';this.channel={readyState:'open',send(){}}}
        addTrack(){return {replaceTrack:async()=>{}}} createDataChannel(){return this.channel}
        async createOffer(){return {type:'offer',sdp:'synthetic-offer'}}
        async setLocalDescription(value){this.localDescription=value}
        async setRemoteDescription(){for(const type of ['session.created','session.updated'])this.channel.onmessage({data:JSON.stringify({type})})}
        close(){}
      };
    })()""")
    page.route('https://**/*',lambda r:r.abort())
    page.route('**/__gleam/voice/config',lambda r:r.fulfill(json={'configured':True,'workspace':'synthetic-workspace'}))
    page.route('**/__gleam/voice/session',lambda r:r.fulfill(json={'sdp':'synthetic-answer'}))
    try:
        page.goto(URL);page.locator('#fab').wait_for();configure(page)
        page.locator('[data-page="page-life"]').click();page.locator('[data-life-chat]').click()
        # Opening awaits stored drafts; a bounding box can still be offscreen before .open.
        page.wait_for_function("()=>{const p=document.querySelector('#sp-life-chat');return p?.classList.contains('open') && getComputedStyle(p).transform==='none'}")
        before=page.locator('.life-chat-input-wrap').bounding_box()
        page.locator('[data-chat-voice]').click();page.locator('[data-voice-start]').click()
        expect(page.locator('[data-voice-mute]')).to_be_visible()
        page.evaluate('window.__pc.ontrack({streams:[new MediaStream()]})')
        expect(page.locator('[data-voice-play]')).to_be_visible();expect(page.locator('[data-voice-interrupt]')).to_be_hidden()
        assert_inline(page);assert page.locator('.life-chat-input-wrap').bounding_box()==before
        page.evaluate('window.__allowPlayback=true');page.locator('[data-voice-play]').click()
        expect(page.locator('[data-voice-play]')).to_be_hidden();expect(page.locator('[data-voice-interrupt]')).to_be_visible()
        page.locator('[data-voice-end]').click();expect(page.locator('[data-chat-voice]')).to_be_enabled()
        assert not errors,errors
        print('PASS compact web playback recovery without resizing',flush=True)
    finally:context.close()


if __name__=='__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for profile in [(360,760,'light',1),(390,844,'light',1),(430,932,'dark',1),(360,560,'light',1.3),(400,810,'dark',1.3),(1280,900,'light',1)]:
            run(browser,*profile);run_geometry(browser,*profile)
        run_web_playback(browser)
        browser.close()
