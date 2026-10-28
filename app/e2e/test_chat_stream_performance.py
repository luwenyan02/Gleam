"""流式绘制、历史节点与终态刷新回归；合成 SSE，不调用真实服务。"""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import configure, open_life, read_rows, set_life_ai_enabled
from chat_seed import index_chat_seed
from test_chat_resume import MOCK, enter, leave
from test_chat_web_search import BRIDGE, emit, finish
from test_native_live_voice import MOCK as NATIVE
from test_voice_markdown import RAW, start as start_voice, emit as emit_voice

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-stream-performance'
RAF_CONTROL = r'''(() => {
  const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
  const held = new Map(); let next = -1;
  window.__holdChatFrames = false;
  window.requestAnimationFrame = callback => {
    if (!window.__holdChatFrames) return request(callback);
    const id = next--; held.set(id, callback); return id;
  };
  window.cancelAnimationFrame = id => { if (!held.delete(id)) cancel(id); };
  window.__pendingChatFrames = () => held.size;
  window.__pendingChatFrameIds = () => [...held.keys()];
  window.__paintChatFrame = () => { const jobs = [...held.values()]; held.clear(); for (const callback of jobs) callback(performance.now()); };
})();'''


def seed(page, count=50):
    page.evaluate('''async count => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
      const photo = {name:'synthetic.jpg', dataUrl:canvas.toDataURL('image/jpeg')};
      const messages = Array.from({length:count}, (_,i) => i%2 ? {role:'assistant', repliedAt:1700000000000+i,
        content:'## 虚构历史 '+i+'\\n\\n这段历史需要保持可选择。**安全强调**\\n\\n|项目|内容|\\n|---|---|\\n|甲|'+ '长表格'.repeat(60) +'|\\n\\n```text\\n<synthetic>\\n```'}
        : {role:'user',content:'虚构历史问题 '+i, ...(i===0 ? {photos:[photo]} : {})});
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('lifeDrafts','readwrite');
      tx.objectStore('lifeDrafts').put({key:'chat:performance',title:'',body:'',occurredAt:1,chatUpdatedAt:Date.now(),existingPhotoRefs:[],photos:[],messages,aiExcluded:false});
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
    }''', count)
    index_chat_seed(page)


def observe(page):
    page.evaluate('''() => {
      const root = document.querySelector('#life-chat-messages');
      window.__history = {bubble:root.firstElementChild, image:root.querySelector('img'), table:root.querySelector('.chat-table-scroll')};
      const p = root.querySelector('.assistant .chat-message-text p');
      const selection = getSelection(), range = document.createRange(); range.selectNodeContents(p);
      selection.removeAllRanges(); selection.addRange(range); window.__selectedHistory = selection.toString();
      root.scrollTop = 0; window.__history.table.scrollLeft = 38; window.__history.tableScroll = window.__history.table.scrollLeft;
      window.__draws = {root:0,stream:0};
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
      if (!window.__originalInnerHtml) {
        window.__originalInnerHtml=descriptor;
        Object.defineProperty(Element.prototype,'innerHTML',{...descriptor,set(value){
          if (this.id==='life-chat-messages') window.__draws.root++;
          if (this.matches('.chat-streaming .chat-message-text')) window.__draws.stream++;
          descriptor.set.call(this,value);
        }});
      }
    }''')


def history_intact(page):
    return page.evaluate('''() => {
      const root=document.querySelector('#life-chat-messages');
      return root.firstElementChild===window.__history.bubble && root.querySelector('img')===window.__history.image
        && root.querySelector('.chat-table-scroll')===window.__history.table && window.__history.table.scrollLeft===window.__history.tableScroll
        && root.scrollTop===0 && getSelection().toString()===window.__selectedHistory;
    }''')


def send(page, text, count):
    page.locator('#life-chat-input').fill(text); page.locator('[data-life-chat-send]').click()
    page.wait_for_function('count => window.__chatRequests.length===count', arg=count)
    expect(page.locator('#dialog-scrim.show')).to_have_count(0)


def streaming(browser, width):
    context=browser.new_context(viewport={'width':width,'height':844}, reduced_motion='reduce',service_workers='block')
    context.route('https://**/*',lambda r:r.abort())
    page=context.new_page(); page.add_init_script(MOCK); page.add_init_script(RAF_CONTROL)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    open_life(page); configure(page); seed(page); enter(page)
    send(page,'虚构追问：继续聊聊。',1);observe(page)
    page.evaluate('''async () => {
      window.__holdChatFrames=true;
      for(let i=0;i<80;i++)window.__chatRequests.at(-1).delta('片段'+i+'。');
      await new Promise(resolve=>setTimeout(resolve,40));
    }''')
    assert page.evaluate('window.__draws.root') == 0, 'delta不能替换历史消息DOM'
    assert history_intact(page), '流式更新须保留历史节点、选区、图片、表格和阅读位置'
    assert page.evaluate('window.__pendingChatFrames()') == 1, '密集delta应合并为一个待绘制帧'
    page.evaluate('window.__paintChatFrame()')
    expect(page.locator('.chat-streaming')).to_contain_text('片段79。')
    assert page.evaluate('window.__draws.stream') == 1, '一个帧只绘制一次当前流式正文'
    assert history_intact(page)
    page.evaluate('''async () => {
      window.__chatRequests.at(-1).delta('\\n\\n**最终安全文字** <img src=x onerror=alert(1)>');
      await new Promise(resolve=>setTimeout(resolve,20));window.__chatRequests.at(-1).finish();
    }''')
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    expect(page.locator('.assistant').last).to_contain_text('最终安全文字')
    expect(page.locator('.assistant').last.locator('strong')).to_have_text('最终安全文字')
    expect(page.locator('.assistant').last.locator('img')).to_have_count(0)
    assert page.evaluate('window.__pendingChatFrames()') == 0, '完成必须立即flush并取消待绘制帧'
    expect(page.locator('.chat-streaming,.chat-incomplete')).to_have_count(0)
    expect(page.locator('.assistant')).to_have_count(26)
    page.evaluate('window.__holdChatFrames=false;getSelection().removeAllRanges()')
    for number, terminal in [(2,'fail'),(3,'stop')]:
        send(page,'虚构终态检查 '+terminal,number)
        page.evaluate('''async terminal => {
          window.__holdChatFrames=true;window.__chatRequests.at(-1).delta('终态前最后片段 '+terminal);
          await new Promise(resolve=>setTimeout(resolve,20));
          if(terminal==='fail')window.__chatRequests.at(-1).fail();else document.querySelector('[data-life-chat-stop]').click();
        }''',terminal)
        expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
        expect(page.locator('.chat-incomplete')).to_contain_text('终态前最后片段 '+terminal)
        assert page.evaluate('window.__pendingChatFrames()') == 0
        page.evaluate('window.__holdChatFrames=false')
    send(page,'虚构离页检查',4)
    page.evaluate('''async()=>{window.__holdChatFrames=true;window.__chatRequests.at(-1).delta('离页仍保留。');await new Promise(r=>setTimeout(r,20));}''')
    pending_chat_frames = set(page.evaluate('window.__pendingChatFrameIds()'))
    assert pending_chat_frames
    leave(page)
    assert pending_chat_frames.isdisjoint(page.evaluate('window.__pendingChatFrameIds()')), '离页须取消已有聊天帧；路由可另安排焦点恢复帧'
    assert not page.evaluate('window.__chatRequests.at(-1).signal.aborted')
    page.evaluate('window.__holdChatFrames=false;window.__paintChatFrame();window.__chatRequests.at(-1).finish()')
    page.wait_for_timeout(150);enter(page)
    expect(page.locator('.assistant').last).to_contain_text('离页仍保留。')
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    assert not errors,errors
    OUT.mkdir(parents=True,exist_ok=True);page.screenshot(path=str(OUT/f'completed-{width}.png'),animations='disabled')
    context.close();print(f'PASS chat stream batching/history/final flush {width}',flush=True)


def search_only(browser):
    context=browser.new_context(viewport={'width':390,'height':844},reduced_motion='reduce',service_workers='block')
    context.route('https://**/*',lambda r:r.abort())
    page=context.new_page();page.add_init_script(BRIDGE);page.add_init_script(RAF_CONTROL)
    open_life(page);configure(page);seed(page)
    page.evaluate('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const tx=db.transaction('settings','readwrite');for(const [key,value] of [['ai.baseUrl','https://dashscope.aliyuncs.com/compatible-mode/v1'],['ai.model','qwen3.8-max']])tx.objectStore('settings').put({key,value});await new Promise(r=>tx.oncomplete=r);db.close();}''')
    enter(page);page.locator('#life-chat-input').fill('虚构问题：现在天气怎么样？');page.locator('[data-life-chat-send]').click()
    page.wait_for_function('window.__searchRequests.length===1');observe(page)
    emit(page,[{'type':'response.web_search_call.searching'}])
    deadline=time.monotonic()+6
    while time.monotonic()<deadline:
        stored=next(d for d in read_rows(page,'lifeDrafts') if d['key']=='chat:performance')
        if stored.get('chatReply',{}).get('search',{}).get('status')=='searching':break
        page.wait_for_timeout(40)
    else:raise AssertionError('搜索元数据须在检查点落盘')
    assert page.evaluate('window.__draws.root') == 0, '隐藏搜索元数据不能重绘正文'
    assert history_intact(page)
    stored=next(d for d in read_rows(page,'lifeDrafts') if d['key']=='chat:performance')
    assert stored['chatReply']['search']['status']=='searching', '搜索元数据仍须保存'
    finish(page,'虚构搜索结果。')
    assert next(d for d in read_rows(page,'lifeDrafts') if d['key']=='chat:performance')['messages'][-1]['search']['status']=='searched'
    context.close();print('PASS hidden search metadata persists without drawing',flush=True)


def retry_cleanup(browser):
    context=browser.new_context(viewport={'width':390,'height':844},reduced_motion='reduce',service_workers='block')
    context.route('https://**/*',lambda r:r.abort())
    page=context.new_page();page.add_init_script(MOCK)
    open_life(page);configure(page);set_life_ai_enabled(page,False);enter(page)
    page.locator('#life-chat-input').fill('虚构取消后重试。');page.locator('[data-life-chat-send]').click()
    page.locator('#dialog-scrim [data-act="cancel"]').click()
    expect(page.locator('[data-chat-cancelled]')).to_have_count(1)
    page.locator('[data-life-chat-retry]').click();page.locator('#dialog-scrim [data-act="ok"]').click()
    page.wait_for_function('window.__chatRequests.length===1')
    expect(page.locator('.life-chat-failed')).to_have_count(0)
    page.evaluate('window.__chatRequests.at(-1).fail()')
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    expect(page.locator('.life-chat-failed')).to_have_count(1)
    page.locator('[data-life-chat-retry]').click()
    page.wait_for_function('window.__chatRequests.length===2')
    expect(page.locator('.life-chat-failed')).to_have_count(0)
    page.evaluate("window.__chatRequests.at(-1).delta('重试完成。');window.__chatRequests.at(-1).finish()")
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    expect(page.locator('.assistant')).to_have_count(1)
    context.close();print('PASS cancelled/failed hints clear before first retry delta',flush=True)


def foreground_priority(browser, kind):
    context=browser.new_context(viewport={'width':390,'height':844},reduced_motion='reduce',service_workers='block')
    context.route('https://**/*',lambda r:r.abort())
    page=context.new_page();page.add_init_script(NATIVE)
    page.add_init_script(r'''(() => {
      const original=window.fetch.bind(window);window.__layoutRequests=[];window.__foregroundRequests=[];
      window.fetch=async (url,options)=>{
        if(!String(url).startsWith('https://life-ai.invalid/'))return original(url,options);
        const request={signal:options.signal,payload:JSON.parse(options.body)};
        if(!request.payload.stream){
          window.__layoutRequests.push(request);
          return new Promise((resolve,reject)=>{
            request.finish=()=>resolve(new Response(JSON.stringify({choices:[{message:{content:'**不应采用的迟到排版**'}}]}),{headers:{'Content-Type':'application/json'}}));
            options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
          });
        }
        window.__foregroundRequests.push(request);
        return new Response('data: '+JSON.stringify({choices:[{delta:{content:'前台文字结果。'}}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
      };
    })();''')
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    open_life(page);configure(page)
    if kind=='ledger':
        page.evaluate('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const tx=db.transaction(['entries','accounts','categories'],'readwrite');tx.objectStore('accounts').put({id:999001,name:'虚构现金',type:'cash',balance:0,initialBalance:0,createdAt:1,updatedAt:1,deletedAt:0});tx.objectStore('categories').put({id:999001,kind:'expense',name:'虚构餐饮',icon:'餐',sortOrder:1,createdAt:1,updatedAt:1});tx.objectStore('entries').put({id:999001,type:'expense',categoryId:999001,accountId:999001,amount:100,occurredAt:Date.now(),deletedAt:0,reimburseStatus:'none',createdAt:1,updatedAt:1});await new Promise(r=>tx.oncomplete=r);db.close();}''')
    enter(page);start_voice(page)
    emit_voice(page,[{'id':'u1','role':'user','content':'说说周末安排'},{'id':'a1','role':'assistant','content':RAW,'complete':True}])
    page.wait_for_function('window.__layoutRequests.length===1')
    page.locator('[data-voice-end]').click();expect(page.locator('.chat-voice-overlay')).to_have_count(0)
    if kind=='regenerate':page.locator('[data-chat-regenerate]').click()
    else:
        page.locator('#life-chat-input').fill('分析我这个月的消费。' if kind=='ledger' else '再说一个周末建议。')
        page.locator('[data-life-chat-send]').click()
    if kind=='ledger':
        page.locator('[data-ledger-cancel]').wait_for()
        assert not page.evaluate('window.__layoutRequests[0].signal.aborted'), '打开账本确认框不能中止排版'
        page.locator('[data-ledger-cancel]').click()
        expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
        assert not page.evaluate('window.__layoutRequests[0].signal.aborted'), '取消账本发送不能中止排版'
        page.locator('[data-life-chat-retry]').click()
        page.locator('[data-ledger-approve]:enabled').click()
    else:
        expect(page.locator('#dialog-scrim.show')).to_have_count(0)
    page.wait_for_function('window.__foregroundRequests.length===1')
    assert page.evaluate('window.__layoutRequests[0].signal.aborted'), '实际发送的前台文字请求必须取消后台排版'
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    if kind!='regenerate':expect(page.locator('#life-chat-messages')).to_contain_text(RAW)
    page.evaluate('window.__layoutRequests[0].finish()')
    expect(page.locator('#life-chat-messages')).not_to_contain_text('不应采用的迟到排版')
    assert page.evaluate('window.__micCalls')==0
    assert not errors,errors
    context.close();print('PASS foreground send cancels layout with ledger approval retained',kind,flush=True)


if __name__=='__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width in (360,390,430,1280):streaming(browser,width)
        search_only(browser);retry_cleanup(browser)
        for kind in ('normal','regenerate','ledger'):foreground_priority(browser,kind)
        browser.close()
