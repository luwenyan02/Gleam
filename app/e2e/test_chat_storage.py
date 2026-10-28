"""会话来源恢复、真正索引分页与照片草稿；只用虚构数据和本地 SSE。"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import open_life, configure, read_rows, URL
from test_chat_resume import MOCK, enter, leave, send, delta, finish, wait_for_draft
from chat_seed import index_chat_seed

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-storage'
INSTRUMENT = '''(() => {
  window.__chatStorage = { fullReads: [], imageClones: 0, clones: 0, decodes: 0, renders: 0 };
  const clone = window.structuredClone, decode = window.atob, all = IDBObjectStore.prototype.getAll;
  window.structuredClone = function(value, ...rest) {
    if (value?.key?.startsWith('chat:')) { window.__chatStorage.clones++; if (JSON.stringify(value).includes('data:image/')) window.__chatStorage.imageClones++; }
    return clone.call(this, value, ...rest);
  };
  window.atob = function(...args) { window.__chatStorage.decodes++; return decode.apply(this, args); };
  IDBObjectStore.prototype.getAll = function(...args) { if (['lifeDrafts','lifeNotes'].includes(this.name)) window.__chatStorage.fullReads.push(this.name); return all.apply(this, args); };
  const html = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(Element.prototype, 'innerHTML', {...html, set(value) { if (this.id === 'life-chat-messages') window.__chatStorage.renders++; html.set.call(this, value); }});
})();'''


def seed(page, count):
    metadata = page.evaluate('''async count => {
      const canvas = document.createElement('canvas'); canvas.width=canvas.height=700;
      const ctx=canvas.getContext('2d'), pixels=ctx.createImageData(700,700);
      let random=177;for(let i=0;i<pixels.data.length;i++){random=(Math.imul(random,1664525)+1013904223)>>>0;pixels.data[i]=i%4===3?255:random>>>24;}
      ctx.putImageData(pixels,0,0); const dataUrl=canvas.toDataURL('image/png');
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction(['lifeDrafts','lifeNotes'],'readwrite');
      for(let i=0;i<count;i++)tx.objectStore('lifeNotes').put({id:500+i,kind:'diary',title:`虚构历史 ${i}`,body:'虚构长正文'.repeat(100),occurredAt:1,createdAt:1,updatedAt:i+2,deletedAt:0,conversation:Array.from({length:40},(_,j)=>({role:j%2?'assistant':'user',content:'虚构历史消息'.repeat(50)}))});
      tx.objectStore('lifeNotes').put({id:90001,kind:'diary',title:'虚构源记录',body:'虚构原正文',occurredAt:Date.now(),createdAt:1,updatedAt:1,deletedAt:0,conversation:[{role:'user',content:'虚构源问题'},{role:'assistant',content:'虚构源回答'}]});
      tx.objectStore('lifeDrafts').put({key:'chat:photos',title:'',body:'',occurredAt:1,chatUpdatedAt:1000,aiExcluded:false,existingPhotoRefs:[],photos:[],messages:[{role:'user',content:'虚构带图消息',photos:Array.from({length:4},(_,i)=>({name:`虚构${i}.png`,dataUrl}))},{role:'assistant',content:'虚构图片回答'}]});
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();return {savedSessions:count,photoBytes:Math.floor((dataUrl.length-dataUrl.indexOf(',')-1)*3/4)};
    }''',count)
    index_chat_seed(page)
    return metadata


def source_from_history(page):
    page.locator('[data-chat-history]').click()
    page.locator('#chat-history-search').fill('虚构源记录')
    expect(page.locator('.chat-history-row')).to_have_count(1)
    page.locator('.chat-history-row').click()
    expect(page.locator('#life-chat-messages')).to_contain_text('虚构源问题')


def mutate_source(page, patch):
    page.evaluate('''async patch => { const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)}); const tx=db.transaction('lifeNotes','readwrite'),store=tx.objectStore('lifeNotes'),read=store.get(90001);read.onsuccess=()=>store.put({...read.result,...patch});await new Promise(r=>tx.oncomplete=r);db.close(); }''', patch)
    index_chat_seed(page)


def run(browser, width, dark=False):
    context=browser.new_context(viewport={'width':width,'height':850},device_scale_factor=1)
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(URL) or route.request.url.startswith(('data:','blob:')) else route.abort())
    page=context.new_page(); errors=[]; page.on('pageerror',lambda error:errors.append(str(error)))
    page.add_init_script(MOCK);page.add_init_script(INSTRUMENT)
    open_life(page);configure(page);metadata=seed(page,1000 if width==390 and not dark else 67)
    if dark: page.evaluate("document.documentElement.dataset.theme='dark';document.documentElement.style.setProperty('--seed-type','1.3')")
    page.evaluate("window.__chatStorage={fullReads:[],imageClones:0,clones:0,decodes:0,renders:0}")
    enter(page);expect(page.locator('.life-chat-message-photos img')).to_have_count(4)
    page.wait_for_timeout(150)
    assert page.evaluate('window.__chatStorage.renders')==1
    assert page.evaluate('window.__chatStorage.fullReads')==[]
    page.locator('#life-chat-input').fill('先保存旧图片')
    wait_for_draft(page,lambda d:all(p.get('attachmentId') and p['dataUrl']=='' for p in d['messages'][0].get('photos',[])),key='chat:photos')
    page.evaluate("window.__chatStorage={fullReads:[],imageClones:0,clones:0,decodes:0,renders:0}")
    page.locator('#life-chat-input').press_sequentially('123456789012',delay=10)
    page.wait_for_timeout(400)
    work=page.evaluate('window.__chatStorage')
    assert work['imageClones']==0 and work['decodes']==0,work
    assert work['clones']<=3,work
    page.locator('[data-chat-history]').click()
    expect(page.locator('.chat-history-row')).to_have_count(30)
    first=page.locator('.chat-history-row strong').all_text_contents()
    page.locator('[data-history-next]').click();expect(page.locator('[data-history-page]')).to_have_text('第 2 页')
    expect(page.locator('.chat-history-row')).to_have_count(30)
    assert not set(first)&set(page.locator('.chat-history-row strong').all_text_contents())
    page.locator('[data-history-prev]').click();expect(page.locator('[data-history-page]')).to_have_text('第 1 页')
    assert page.locator('.chat-history-row strong').all_text_contents()==first
    assert page.evaluate('window.__chatStorage.fullReads')==[]
    page.locator('.chat-history-pages').scroll_into_view_if_needed();page.wait_for_timeout(150)
    assert page.locator('[data-history-page]').evaluate('el=>el.getBoundingClientRect().height<30'), '页码应保持一行'
    page.screenshot(path=str(OUT/f'history-{width}-{dark}.png'),animations='disabled')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.locator('[data-history-close]').click();source_from_history(page);leave(page)
    assert not any(d['key']=='chat:note:90001' for d in read_rows(page,'lifeDrafts'))
    # 与旧版本遗留草稿一致，标题变化后重进可继续发送。
    page.evaluate('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const tx=db.transaction('lifeDrafts','readwrite');tx.objectStore('lifeDrafts').put({key:'chat:note:90001',noteId:90001,sourceUpdatedAt:1,title:'',body:'',occurredAt:1,chatUpdatedAt:Date.now(),aiExcluded:false,existingPhotoRefs:[],photos:[],messages:[{role:'user',content:'虚构源问题'},{role:'assistant',content:'虚构源回答'}]});await new Promise(r=>tx.oncomplete=r);db.close();}''')
    mutate_source(page,{'title':'虚构源记录新标题','updatedAt':2})
    enter(page);send(page,'虚构继续提问',1);delta(page,'虚构成功回答');finish(page)
    wait_for_draft(page,lambda d:len(d['messages'])==4 and not d.get('chatReply'),key='chat:note:90001')
    page.locator('#life-chat-input').fill('冲突时不能丢失的输入');leave(page)
    mutate_source(page,{'updatedAt':3,'conversation':[{'role':'user','content':'虚构另一处的新会话'}]})
    enter(page);expect(page.locator('[data-chat-source]')).to_be_visible()
    expect(page.locator('#life-chat-input')).to_have_value('冲突时不能丢失的输入')
    expect(page.locator('[data-life-chat-send]')).to_be_disabled()
    page.wait_for_timeout(200)
    page.screenshot(path=str(OUT/f'conflict-{width}-{dark}.png'),animations='disabled')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.locator('[data-chat-reload]').click()
    expect(page.locator('#life-chat-messages')).to_contain_text('虚构另一处的新会话')
    expect(page.locator('[data-chat-source]')).to_be_hidden()
    copies=[d for d in read_rows(page,'lifeDrafts') if d['key'].startswith('chat:recovered:')]
    assert len(copies)==1 and copies[0]['pendingReply']=='冲突时不能丢失的输入'
    assert len(copies[0]['messages'])==4 and copies[0]['noteId']==90001
    send(page,'虚构新基线问题',2);delta(page,'新基线回答');finish(page)
    wait_for_draft(page,lambda d:len(d['messages'])==3 and not d.get('chatReply'),key='chat:note:90001')
    # 活动流不偷换来源版本；来源变化后仍保存片段，用户可手动重试。
    send(page,'虚构进行中的问题',3);delta(page,'活动流不能丢的片段');leave(page)
    mutate_source(page,{'title':'虚构源记录再次改名','updatedAt':4});enter(page)
    expect(page.locator('[data-chat-source]')).to_be_visible()
    expect(page.locator('[data-chat-reload]')).to_be_disabled()
    expect(page.locator('.chat-streaming')).to_contain_text('活动流不能丢的片段')
    finish(page);expect(page.locator('.chat-incomplete')).to_contain_text('活动流不能丢的片段')
    expect(page.locator('[data-chat-source]')).to_be_hidden()
    assert page.evaluate('window.__chatRequests.length')==3
    page.locator('[data-life-chat-retry]').click();page.wait_for_function('window.__chatRequests.length===4')
    delta(page,'手动重试完整回答');finish(page)
    wait_for_draft(page,lambda d:len(d['messages'])==5 and not d.get('chatReply'),key='chat:note:90001')
    leave(page);mutate_source(page,{'aiExcluded':True,'updatedAt':5});enter(page)
    expect(page.locator('[data-chat-source]')).to_contain_text('排除 AI')
    expect(page.locator('[data-life-chat-send]')).to_be_disabled()
    assert page.evaluate('window.__chatRequests.length')==4
    leave(page);mutate_source(page,{'aiExcluded':False,'updatedAt':6});enter(page)
    expect(page.locator('[data-chat-source]')).to_be_hidden()
    # 另一连接删除来源后，发送前复核仍阻止请求，刚输入的文字保留。
    mutate_source(page,{'deletedAt':7,'updatedAt':7})
    page.locator('#life-chat-input').fill('删除来源后保留的输入');page.locator('[data-life-chat-send]').click()
    expect(page.locator('[data-chat-source]')).to_contain_text('已删除')
    expect(page.locator('#life-chat-messages')).to_contain_text('删除来源后保留的输入')
    assert page.evaluate('window.__chatRequests.length')==4
    assert not errors,errors
    context.close();return {'width':width,'dark':dark,'seed':metadata,'typing':work}


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        results=[run(browser,width,dark) for width,dark in [(360,False),(390,False),(430,False),(1280,False),(390,True)]]
        browser.close()
    (OUT/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
    print(json.dumps(results,ensure_ascii=False))
