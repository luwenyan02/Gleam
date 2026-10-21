"""Home life rows open a read-only preview without changing ledger or drafts."""
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4602/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/home-life-preview'
TITLE = '虚构晚风里的完整日记 <不是标签>'
ORIGINAL = '虚构用户原话第一行。\n第二行完整保留 <b>原样文字</b>。'
ANSWER = '虚构拾光原始回复：记住这一刻。'
BODY = ('第一行：沿着河边慢慢走。\n第二行：换行应当保留。\n'
        '<img src=x onerror="window.__lifePreviewExecuted=1">\n'
        '<script>window.__lifePreviewExecuted=2</script>\n'
        + '虚构的长内容，让阅读完整延续到屏幕之外。' * 75
        + '\n最后一行：日记正文没有被截断。')
SEED = r'''async ({title,body,originalBody,answer}) => {
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
 const photos=[];
 for(const [id,w,h] of [[1,900,500],[2,500,900]]) {
   const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
   const c=canvas.getContext('2d');c.fillStyle='#dce9f4';c.fillRect(0,0,w,h);
   for(const [color,x,y] of [['#df6247',0,0],['#408c62',w-90,0],['#6388c8',0,h-90],['#d4a438',w-90,h-90]]){c.fillStyle=color;c.fillRect(x,y,90,90)}
   c.fillStyle='#25384b';c.font='36px sans-serif';c.fillText(`FICTIONAL ${w} x ${h}`,110,Math.floor(h/2));
   photos.push({id,blob:await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))});
 }
 const names=['entries','accounts','categories','lifeNotes','lifeDrafts','attachments','habits','habitChecks','settings'];
 const tx=db.transaction(names,'readwrite');for(const name of names.filter(n=>n!=='settings'))tx.objectStore(name).clear();
 const stamp={createdAt:1,updatedAt:1},when=new Date(2026,9,17,12,34).getTime();
 tx.objectStore('accounts').put({...stamp,id:1,name:'虚构现金',group:'cash',balance:100000,hidden:false,countInNetWorth:true,sortOrder:1});
 tx.objectStore('categories').put({...stamp,id:1,name:'虚构餐饮',kind:'expense',icon:'ic-bowl',sortOrder:1});
 tx.objectStore('entries').put({...stamp,id:101,type:'expense',amount:1234,occurredAt:when-1000,accountId:1,categoryId:1,note:'虚构同ID账单',deletedAt:0,reimburseStatus:'none'});
 const notes=[
   {id:101,kind:'diary',title,body,originalBody,conversation:[{role:'user',content:originalBody},{role:'assistant',content:answer}],mood:'平静 <安全>',tags:['散步','虚构标签 <b>原文</b>']},
   {id:102,kind:'photo',title:'虚构横竖照片记录',body:'两张完整照片，四角均可见。',photoRefs:[1,2,999],conversation:[{role:'user',content:'虚构照片问题',photoRefs:[1,2]},{role:'assistant',content:answer}]},
   {id:103,kind:'habit',title:'虚构已删除习惯的历史打卡',body:'历史打卡仍可阅读。',habitId:404},
   {id:104,kind:'diary',title:'虚构稍后删除的记录',body:'打开前删除时应当给出明确提示。'},
   {id:105,kind:'photo',title:'虚构全部照片缺失',photoRefs:[998],originalBody:'虚构旧版原话，不应在预览展示'},
   {id:106,kind:'diary',title:'虚构稍后移除的记录',body:'不存在时也有明确反馈。'},
 ];
 notes.forEach((n,i)=>tx.objectStore('lifeNotes').put({...stamp,...n,occurredAt:when+i*1000,deletedAt:0}));
 for(let i=0;i<20;i++)tx.objectStore('lifeNotes').put({...stamp,id:200+i,kind:'diary',title:`虚构列表占位 ${i}`,body:'用于验证滚动位置保留。',occurredAt:when+60000+i*1000,deletedAt:0});
 tx.objectStore('lifeDrafts').put({...stamp,key:'new',kind:'diary',title:'虚构未保存草稿',body:'已有草稿必须原样保留。',photoRefs:[],tags:[],occurredAt:when});
 tx.objectStore('lifeDrafts').put({key:'chat:new',title:'',body:'',occurredAt:when,existingPhotoRefs:[],photos:[],messages:[{role:'user',content:'虚构其他会话'},{role:'assistant',content:'其他回复'}],pendingReply:'虚构未发出的聊天草稿',aiExcluded:false});
 photos.forEach(({id,blob})=>tx.objectStore('attachments').put({...stamp,id,blob,mime:'image/png',size:blob.size,name:`fictional-${id}.png`}));
 tx.objectStore('settings').put({key:'accounting.monthStartDay',value:1});
 tx.objectStore('settings').put({key:'life.aiEnabled',value:false});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}'''
READ = '''async()=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
 const names=['entries','accounts','lifeNotes','lifeDrafts'];const tx=db.transaction(names,'readonly');
 const rows=await Promise.all(names.map(name=>new Promise(resolve=>{const r=tx.objectStore(name).getAll();r.onsuccess=()=>resolve([name,r.result])})));
 db.close();return Object.fromEntries(rows);
}'''


def preview(page):
    sheet = page.locator('#sheet.open[aria-label="拾光记录预览"]')
    expect(sheet).to_be_visible()
    return sheet


def open_note(page, note_id, action='click'):
    row = page.locator(f'#hm-days [data-home-life-note="{note_id}"]')
    expect(row).to_have_attribute('role', 'button')
    expect(row).to_have_attribute('tabindex', '0')
    row.scroll_into_view_if_needed()
    if action == 'tap':
        row.tap()
    elif action == 'click':
        row.click()
    else:
        row.focus()
        row.press(action)
    return row, preview(page)


def close_and_check(page, row, scroll, action='button'):
    if action == 'button':
        page.locator('[data-life-preview-close]').click()
    elif action == 'back':
        page.go_back()
    else:
        page.keyboard.press('Escape')
    expect(page.locator('#sheet')).to_have_attribute('aria-hidden', 'true')
    expect(row).to_be_focused()
    assert abs(page.locator('#page-home').evaluate('e=>e.scrollTop') - scroll) < 2


def delayed_read_and_urls(page):
    """Delay native request callbacks, without changing the app or saved data."""
    page.evaluate('''()=>{
      const get=IDBObjectStore.prototype.get;
      const success=Object.getOwnPropertyDescriptor(IDBRequest.prototype,'onsuccess');
      window.__previewDelayStore='lifeNotes';window.__previewPendingReads=0;
      IDBObjectStore.prototype.get=function(...args){
        const request=get.apply(this,args);
        if(this.name!==window.__previewDelayStore)return request;
        window.__previewPendingReads++;
        let listener;
        Object.defineProperty(request,'onsuccess',{
          configurable:true,get:()=>listener,set(callback){
            listener=callback;
            success.set.call(request,function(event){setTimeout(()=>{
              window.__previewPendingReads--;callback.call(request,event);
            },250)});
          }
        });
        return request;
      };
      const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
      window.__previewActiveUrls=[];window.__previewCreatedUrls=0;
      URL.createObjectURL=function(blob){const url=create.call(this,blob);window.__previewActiveUrls.push(url);window.__previewCreatedUrls++;return url};
      URL.revokeObjectURL=function(url){window.__previewActiveUrls=window.__previewActiveUrls.filter(x=>x!==url);return revoke.call(this,url)};
    }''')
    row,sheet=open_note(page,101)
    expect(sheet).to_contain_text('正在读取记录')
    assert page.evaluate('window.__previewPendingReads')>0
    close_and_check(page,row,page.locator('#page-home').evaluate('e=>e.scrollTop'))
    page.wait_for_function('window.__previewPendingReads===0')
    expect(page.locator('#sheet')).to_have_attribute('aria-hidden','true')
    page.evaluate('window.__previewDelayStore="attachments"')
    row,sheet=open_note(page,102)
    expect(sheet).to_contain_text('正在读取照片')
    close_and_check(page,row,page.locator('#page-home').evaluate('e=>e.scrollTop'))
    page.wait_for_function('window.__previewPendingReads===0')
    assert page.evaluate('window.__previewCreatedUrls')==0, 'Closed loading preview created late URLs'
    page.evaluate('window.__previewDelayStore=""')
    row,sheet=open_note(page,102)
    expect(sheet.locator('img')).to_have_count(2)
    assert page.evaluate('window.__previewActiveUrls.length')==2
    close_and_check(page,row,page.locator('#page-home').evaluate('e=>e.scrollTop'))
    assert page.evaluate('window.__previewActiveUrls.length')==0, 'Preview URLs were not released'


def run(browser, width, height, scale, theme, red=False):
    context = browser.new_context(viewport={'width':width,'height':height},locale='zh-CN',
        timezone_id='Asia/Shanghai',has_touch=width<600,is_mobile=width<600,
        service_workers='block',reduced_motion='reduce')
    external, errors = [], []
    def route(request):
        url = urlsplit(request.request.url)
        if url.netloc == urlsplit(URL).netloc or url.scheme in ('blob','data'):
            request.continue_()
        else:
            external.append(request.request.url)
            request.abort()
    context.route('**/*',route)
    page = context.new_page()
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.clock.set_fixed_time(datetime.fromisoformat('2026-10-18T12:00:00+08:00'))
    page.goto(URL);page.locator('#fab').wait_for()
    page.evaluate(SEED,{'title':TITLE,'body':BODY,'originalBody':ORIGINAL,'answer':ANSWER});page.reload();page.locator('#fab').wait_for()
    page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",String(scale))}',[theme,scale])
    expect(page.locator('#hm-days')).to_contain_text(TITLE)
    page.evaluate('document.fonts.ready')
    before = page.evaluate(READ)
    page.evaluate('''()=>{
      window.__lifePreviewWrites=[];
      for(const method of ['add','put','delete','clear']){
        const original=IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method]=function(...args){
          if(['lifeNotes','lifeDrafts','entries','accounts'].includes(this.name))window.__lifePreviewWrites.push([this.name,method]);
          return original.apply(this,args);
        };
      }
    }''')
    # Use the existing visible title first: the old build must fail on opening,
    # rather than merely fail because its DOM lacks the new test attribute.
    row = page.locator('#hm-days article').filter(has=page.locator('.e-title',has_text=TITLE))
    expect(row).to_have_count(1)
    row.scroll_into_view_if_needed();row.click()
    try:
        sheet = preview(page)
    except AssertionError:
        page.screenshot(path=str(OUT/f'red-{width}.png'),animations='disabled')
        raise
    row = page.locator('#hm-days [data-home-life-note="101"]')
    scroll = page.locator('#page-home').evaluate('e=>e.scrollTop')
    content = sheet.locator('[data-life-preview-content]')
    expect(sheet).to_contain_text(TITLE)
    assert BODY in content.text_content(), 'Full body and newline characters must survive'
    expect(content).to_contain_text('2026')
    expect(content).to_contain_text('10月17日')
    expect(content).to_contain_text('12:34')
    expect(content).to_contain_text('平静 <安全>')
    expect(content).to_contain_text('虚构标签 <b>原文</b>')
    expect(content.locator('script,img,b,iframe,input,textarea,[contenteditable="true"]')).to_have_count(0)
    assert not page.evaluate('window.__lifePreviewExecuted')
    body_style = content.evaluate('''(el,body)=>{
      const match=[...el.querySelectorAll('*')].find(e=>e.textContent===body);
      return match?getComputedStyle(match).whiteSpace:null;
    }''',BODY)
    assert body_style in ('pre-wrap','pre-line','break-spaces'), body_style
    expect(sheet.locator('[data-life-preview-close]')).to_be_in_viewport()
    expect(sheet.locator('input,textarea,[contenteditable="true"],[data-lc-save],[data-lc-ai]')).to_have_count(0)
    assert sheet.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    label=f'{width}x{height}-{theme}-text{scale}'
    page.screenshot(path=str(OUT/f'diary-{label}.png'),animations='disabled')
    sheet.locator('[data-life-preview-close]').focus()
    page.keyboard.press('Tab')
    link=sheet.get_by_role('button',name='查看原始对话')
    expect(link).to_be_focused()
    expect(sheet).to_contain_text('原始对话')
    expect(sheet.locator('details,summary')).to_have_count(0)
    assert ORIGINAL not in content.text_content() and ANSWER not in content.text_content()
    assert link.bounding_box()['height']>=44
    link.scroll_into_view_if_needed()
    page.screenshot(path=str(OUT/f'original-link-{label}.png'),animations='disabled')
    close_and_check(page,row,scroll)
    for action,close in [('Enter','Escape'),('Space','back')]:
        row,sheet=open_note(page,101,action)
        close_and_check(page,row,page.locator('#page-home').evaluate('e=>e.scrollTop'),close)
    row,sheet=open_note(page,102,'tap' if width<600 else 'click')
    scroll=page.locator('#page-home').evaluate('e=>e.scrollTop')
    images=sheet.locator('[data-life-preview-content] img')
    expect(images).to_have_count(2)
    page.wait_for_function('''()=>[...document.querySelectorAll('[data-life-preview-content] img')].every(i=>i.complete&&i.naturalWidth>0)''')
    dimensions=images.evaluate_all('''imgs=>imgs.map(i=>{
      const s=getComputedStyle(i),r=i.getBoundingClientRect();
      return {natural:[i.naturalWidth,i.naturalHeight],box:[r.width,r.height],fit:s.objectFit};
    })''')
    assert [d['natural'] for d in dimensions]==[[900,500],[500,900]], dimensions
    for d in dimensions:
        assert d['fit']=='contain' or abs(d['box'][0]/d['box'][1]-d['natural'][0]/d['natural'][1])<0.02, d
    expect(sheet).to_contain_text('照片不可用')
    expect(sheet.get_by_role('button',name='查看原始对话')).to_be_visible()
    page.wait_for_timeout(350)  # Let Chromium's native touch highlight finish.
    page.screenshot(path=str(OUT/f'photos-{label}.png'),animations='disabled')
    sheet.locator('[data-life-preview-content]').evaluate('e=>e.scrollTop=e.scrollHeight')
    expect(sheet.locator('[data-life-preview-close]')).to_be_in_viewport()
    page.screenshot(path=str(OUT/f'photos-tail-{label}.png'),animations='disabled')
    assert sheet.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    close_and_check(page,row,scroll)
    row,sheet=open_note(page,103)
    expect(sheet).to_contain_text('虚构已删除习惯的历史打卡')
    expect(sheet).to_contain_text('历史打卡仍可阅读。')
    close_and_check(page,row,page.locator('#page-home').evaluate('e=>e.scrollTop'))
    row,sheet=open_note(page,105)
    expect(sheet).to_contain_text('照片不可用')
    expect(sheet.locator('img')).to_have_count(0)
    expect(sheet).to_contain_text('未保留原始对话')
    expect(sheet.get_by_role('button',name='查看原始对话')).to_have_count(0)
    assert '虚构旧版原话' not in sheet.inner_text()
    page.screenshot(path=str(OUT/f'legacy-{label}.png'),animations='disabled')
    close_and_check(page,row,page.locator('#page-home').evaluate('e=>e.scrollTop'))
    # Identical numeric IDs in independent stores must keep their own routes.
    page.locator('#hm-days [data-entry="101"]').click()
    expect(page.locator('#sp-entry-view')).to_be_visible()
    expect(page.locator('#sp-entry-view')).to_contain_text('虚构同ID账单')
    expect(page.locator('#sheet.open[aria-label="拾光记录预览"]')).to_have_count(0)
    page.locator('#sp-entry-view .sub-head [data-act="back"]').click()
    page.locator('#sp-entry-view').wait_for(state='detached')
    if width==390 and scale==1:
        delayed_read_and_urls(page)
    assert page.evaluate(READ)==before, 'Preview/close/entry view changed saved notes, drafts or ledger'
    assert page.evaluate('window.__lifePreviewWrites')==[], 'Preview must issue no writes'
    # Navigate by the saved note ID, rather than resuming the unrelated latest chat.
    row,sheet=open_note(page,101)
    scroll=page.locator('#page-home').evaluate('e=>e.scrollTop')
    link=sheet.get_by_role('button',name='查看原始对话')
    link.focus();link.press('Enter' if width<600 else 'Space')
    chat=page.locator('#sp-life-chat')
    expect(chat).to_be_visible()
    expect(page.locator('#sheet')).to_have_attribute('aria-hidden','true')
    expect(chat.locator('.user .chat-message-text')).to_have_text(ORIGINAL)
    expect(chat.locator('.assistant .chat-message-text')).to_have_text(ANSWER)
    expect(chat.locator('#life-chat-input')).to_have_value('')
    expect(chat).not_to_contain_text('虚构其他会话')
    page.screenshot(path=str(OUT/f'original-chat-{label}.png'),animations='disabled')
    if width==390 and scale==1:
        page.evaluate("document.dispatchEvent(new CustomEvent('gleam:system-back'))")
    elif width==430:
        page.go_back()
    else:
        chat.locator('[data-act="back"]').click()
    chat.wait_for(state='detached')
    expect(row).to_be_focused()
    assert abs(page.locator('#page-home').evaluate('e=>e.scrollTop')-scroll)<2
    page.wait_for_function('''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const row=await new Promise(resolve=>{const r=db.transaction('lifeDrafts').objectStore('lifeDrafts').get('chat:note:101');r.onsuccess=()=>resolve(r.result)});
      db.close();return row?.messages.length===2;
    }''')
    after=page.evaluate(READ)
    for name in ['entries','accounts','lifeNotes']:
        assert after[name]==before[name], f'Opening original chat changed {name}'
    assert [d for d in after['lifeDrafts'] if d['key']!='chat:note:101']==before['lifeDrafts']
    # Keep the rendered rows stale while their records disappear from IndexedDB.
    page.evaluate('''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('lifeNotes','readwrite'),store=tx.objectStore('lifeNotes');
      const r=store.get(104);r.onsuccess=()=>store.put({...r.result,deletedAt:Date.now()});store.delete(106);
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
      window.__lifePreviewWrites=[];
    }''')
    deleted_before=page.evaluate(READ)
    for note_id in [104,106]:
        row,sheet=open_note(page,note_id)
        expect(sheet).to_contain_text('这条记录已删除或不存在')
        close_and_check(page,row,page.locator('#page-home').evaluate('e=>e.scrollTop'))
    assert page.evaluate(READ)==deleted_before
    assert page.evaluate('window.__lifePreviewWrites')==[]
    if width==390 and scale==1:
        row,sheet=open_note(page,101)
        page.evaluate('''async()=>{
          const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
          const tx=db.transaction('lifeNotes','readwrite');tx.objectStore('lifeNotes').delete(101);
          await new Promise(resolve=>tx.oncomplete=resolve);db.close();window.__lifePreviewWrites=[];
        }''')
        stale_before=page.evaluate(READ)
        sheet.get_by_role('button',name='查看原始对话').click()
        expect(page.locator('#toast')).to_contain_text('这条记录已不在当前生活时间流中')
        expect(page.locator('#sp-life-chat')).to_have_count(0)
        expect(row).to_be_focused()
        assert page.evaluate(READ)==stale_before
        assert page.evaluate('window.__lifePreviewWrites')==[]
    assert not external,external
    assert not errors,errors
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    print('PASS home life preview',label,'photo dimensions',dimensions,flush=True)
    context.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    red=os.environ.get('GLEAM_HOME_LIFE_RED')=='1'
    with sync_playwright() as p:
        browser=p.chromium.launch()
        configs=[(390,844,1,'light')] if red else [
            (360,844,1,'light'),(390,844,1,'dark'),(430,844,1,'light'),
            (1280,900,1,'dark'),(390,640,1.3,'dark')]
        for config in configs:
            run(browser,*config,red=red)
        browser.close()
