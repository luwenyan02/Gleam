"""聊天本地图片与图表：真实浏览器、虚构素材、可控 SSE，禁止外部请求。"""
import base64
import json
import os
import struct
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright
from test_chat_resume import MOCK, appearance, delta, enter, finish, leave, send, wait_for_draft
from test_life_ai import URL, configure, open_life, read_rows
from test_short_voice import MOCK_NATIVE
from test_chat_ledger_analysis import (
    MONTHS, NETS, assert_read_only, assert_scope, ledger_snapshot,
    ready, seed as seed_ledger, summary as ledger_summary, watch_writes,
)

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-artifacts'
CHARTS = [
    {'version': 1, 'type': 'bar', 'title': '虚构收支：负数与零',
     'labels': ['虚构超长分类名称需要完整阅读而不是挤出卡片', '退款', '零额'],
     'series': [{'name': '虚构金额', 'values': [12345, -2500, 0]}], 'unit': '元', 'valueDivisor': 100},
    {'version': 1, 'type': 'line', 'title': '虚构散步趋势', 'labels': ['周一', '周二', '周三'],
     'series': [{'name': '步数变化', 'values': [-5, 0, 12]}, {'name': '另一组', 'values': [8, 0, -2]}]},
    {'version': 1, 'type': 'donut', 'title': '虚构时间分配 <安全>', 'labels': ['散步', '阅读', '零额'],
     'series': [{'name': '分钟', 'values': [30, 10, 0]}], 'unit': '分钟'},
]
CAPTURE = r'''(() => {
  window.__artifactShares=[];window.__artifactCancelShare=false;
  Object.defineProperty(navigator,'canShare',{configurable:true,value:({files})=>files?.every(f=>f instanceof File && f.type==='image/png')});
  Object.defineProperty(navigator,'share',{configurable:true,value:async value=>{
    const files=await Promise.all((value.files||[]).map(async f=>({name:f.name,type:f.type,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))})));
    window.__artifactShares.push({files});
    if(window.__artifactCancelShare)throw new DOMException('synthetic cancel','AbortError');
  }});
  Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{window.__artifactCopied=text}});
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  window.__artifactUrls=[];window.__artifactUrlsCreated=0;
  URL.createObjectURL=function(blob){const url=create.call(this,blob);window.__artifactUrls.push(url);window.__artifactUrlsCreated++;return url};
  URL.revokeObjectURL=function(url){window.__artifactUrls=window.__artifactUrls.filter(x=>x!==url);return revoke.call(this,url)};
})();'''
PHOTO = r'''async()=>{
 const canvas=document.createElement('canvas');canvas.width=900;canvas.height=500;
 const c=canvas.getContext('2d');c.fillStyle='#dfebf6';c.fillRect(0,0,900,500);
 for(const [color,x,y] of [['#ef563a',0,0],['#25804d',810,0],['#395fa8',0,410],['#ddb132',810,410]]){c.fillStyle=color;c.fillRect(x,y,90,90)}
 c.fillStyle='#24374c';c.font='40px sans-serif';c.fillText('FICTIONAL PHOTO',200,250);
 return canvas.toDataURL('image/png');
}'''
NATIVE_FILES = r'''(()=>{
 const cap=window.Capacitor,original=cap.nativePromise;
 cap.PluginHeaders.push({name:'Filesystem',methods:['writeFile','deleteFile'].map(name=>({name,rtype:'promise'}))},
   {name:'Share',methods:['canShare','share'].map(name=>({name,rtype:'promise'}))});
 window.__nativeImageCalls=[];window.__nativeCancelImage=false;
 cap.nativePromise=async(plugin,method,options={})=>{
   if(!['Filesystem','Share'].includes(plugin))return original(plugin,method,options);
   window.__nativeImageCalls.push({plugin,method,...options});
   if(plugin==='Filesystem'&&method==='writeFile')return {uri:'file:///synthetic/'+options.directory+'/'+options.path};
   if(method==='canShare')return {value:true};
   if(method==='share'&&window.__nativeCancelImage)throw new Error('Share canceled');
   return {};
 };
})();'''


def fence(chart):
    return '\n\n```gleam-chart\n' + json.dumps(chart, ensure_ascii=False) + '\n```\n'


def check_png(page, data, photo=False):
    """Read the actual exported file, including decoded pixels, not just its filename."""
    assert data[:8] == b'\x89PNG\r\n\x1a\n', '导出的必须是真实 PNG'
    width, height = struct.unpack('>II', data[16:24])
    if photo:
        assert (width, height) == (900, 500)
    else:
        assert width >= 320 and height >= 180
    pixels = page.evaluate('''async encoded=>{
      const img=new Image();img.src='data:image/png;base64,'+encoded;await img.decode();
      const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
      const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(0,0,c.width,c.height).data;
      const colors=new Set();let visible=0;
      for(let i=0;i<d.length;i+=4){if(d[i+3])visible++;if(d[i+3]>100)colors.add(`${d[i]},${d[i+1]},${d[i+2]}`)}
      return {colors:colors.size,visible,corners:[[5,5],[c.width-5,5],[5,c.height-5],[c.width-5,c.height-5]].map(([a,b])=>Array.from(x.getImageData(a,b,1,1).data))};
    }''', base64.b64encode(data).decode())
    assert pixels['colors'] > 8 and pixels['visible'] > width * height / 5, pixels
    if photo:
        assert [p[:3] for p in pixels['corners']] == [[239,86,58],[37,128,77],[57,95,168],[221,177,50]], pixels
    return width, height


def download_png(page, button, name, photo=False):
    with page.expect_download() as pending:
        button.click()
    download = pending.value
    assert download.failure() is None
    assert download.suggested_filename.lower().endswith('.png')
    target = OUT / name
    download.save_as(target)
    return check_png(page, target.read_bytes(), photo)


def share_png(page, button, photo=False, cancel=False):
    previous = page.evaluate('window.__artifactShares.length')
    page.evaluate('cancel=>window.__artifactCancelShare=cancel', cancel)
    button.click()
    page.wait_for_function('n=>window.__artifactShares.length===n+1', arg=previous)
    files = page.evaluate('window.__artifactShares.at(-1).files')
    assert len(files) == 1 and files[0]['type'] == 'image/png'
    assert files[0]['name'].lower().endswith('.png')
    check_png(page, bytes(files[0]['bytes']), photo)
    if cancel:
        page.wait_for_timeout(100)
        assert '失败' not in page.locator('#toast').inner_text(), '取消分享不应报告失败'
        if page.locator('#sheet.open[aria-label="图片预览"]').count():
            assert '失败' not in page.locator('#sheet').inner_text(), '图片分享取消不应报告失败'
    page.evaluate('window.__artifactCancelShare=false')


def image_preview(page, trigger, label, photo=True, close='Escape', export=True):
    trigger.scroll_into_view_if_needed();trigger.focus();trigger.press('Enter')
    sheet = page.locator('#sheet.open[aria-label="图片预览"]')
    expect(sheet).to_be_visible()
    image = sheet.locator('img')
    expect(image).to_have_count(1)
    page.wait_for_function('''()=>{const i=document.querySelector('#sheet.open[aria-label="图片预览"] img');return i?.complete&&i.naturalWidth>0}''')
    fit = image.evaluate('e=>{const r=e.getBoundingClientRect();return {fit:getComputedStyle(e).objectFit,natural:[e.naturalWidth,e.naturalHeight],box:[r.width,r.height]}}')
    assert fit['fit'] == 'contain' or abs(fit['box'][0]/fit['box'][1]-fit['natural'][0]/fit['natural'][1]) < .02, fit
    assert sheet.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    page.screenshot(path=str(OUT / f'preview-{label}.png'), animations='disabled')
    if export:
        download_png(page, sheet.get_by_role('button', name='保存图片', exact=True), f'photo-{label}.png', photo)
        share_png(page, sheet.get_by_role('button', name='分享图片', exact=True), photo)
        share_png(page, sheet.get_by_role('button', name='分享图片', exact=True), photo, cancel=True)
    if close == 'back':
        page.go_back()
    else:
        page.keyboard.press(close)
    expect(page.locator('#sheet')).to_have_attribute('aria-hidden', 'true')
    expect(trigger).to_be_focused()


def setup(browser, width, height, theme, scale, native=False):
    context = browser.new_context(viewport={'width': width, 'height': height}, locale='zh-CN',
        has_touch=width<600, reduced_motion='reduce', service_workers='block', accept_downloads=True)
    external, errors = [], []
    def route(request):
        url = urlsplit(request.request.url)
        if url.netloc == urlsplit(URL).netloc or url.scheme in ('data', 'blob'):
            request.continue_()
        else:
            external.append(request.request.url);request.abort()
    context.route('**/*', route)
    page = context.new_page();page.set_default_timeout(8000)
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script((MOCK_NATIVE+';'+NATIVE_FILES if native else '')+MOCK+CAPTURE)
    open_life(page);configure(page);appearance(page, theme, scale);enter(page)
    return context, page, external, errors


def layout(page, label):
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    for card in page.locator('[data-chat-chart]').all():
        assert card.evaluate('e=>e.scrollWidth<=e.clientWidth+1'), label
        collisions=card.evaluate('''el=>{
          const article=el.closest('article'),rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
          const exports=[...el.querySelectorAll('[data-chat-chart-save],[data-chat-chart-share]')];
          const replies=[...article.querySelectorAll('[data-chat-copy],[data-chat-regenerate]')];
          return exports.flatMap(a=>replies.filter(b=>{const x=rect(a),y=rect(b);return Math.min(x.x+x.w,y.x+y.w)-Math.max(x.x,y.x)>.5&&Math.min(x.y+x.h,y.y+y.h)-Math.max(x.y,y.y)>.5}).map(b=>({export:a.outerHTML,reply:b.outerHTML,exportBox:rect(a),replyBox:rect(b)})));
        }''')
        if collisions:
            card.evaluate('''el=>{const p=document.querySelector('#life-chat-messages');p.scrollTo({top:p.scrollTop+el.closest('article').getBoundingClientRect().bottom-p.getBoundingClientRect().bottom,behavior:'instant'})}''')
            page.screenshot(path=str(OUT/f'collision-{label}.png'),animations='disabled')
        assert not collisions, ('图表导出与回复按钮命中区重叠',label,collisions)
        for button in card.locator('button').all():
            box=button.bounding_box()
            if box:
                assert box['width'] >= 43 and box['height'] >= 43, (label, box)
    page.evaluate('document.fonts.ready')
    page.locator('#life-chat-messages').evaluate("e=>e.scrollTo({top:e.scrollHeight,behavior:'instant'})")
    page.screenshot(path=str(OUT / f'charts-{label}.png'), animations='disabled')


def no_automatic_writes(page, before):
    for name, rows in before.items():
        assert read_rows(page, name) == rows, f'本地图表/预览不应修改 {name}'


def run(browser, width, height, theme, scale, red=False):
    context, page, external, errors = setup(browser, width, height, theme, scale)
    label=f'{width}x{height}-{theme}-{scale}'
    try:
        before={name:read_rows(page,name) for name in ['entries','accounts','lifeNotes']}
        photo=page.evaluate(PHOTO)
        page.locator('#lchat-file').set_input_files({'name':'fictional-corners.png','mimeType':'image/png','buffer':base64.b64decode(photo.split(',')[1])})
        expect(page.locator('#life-chat-photos img')).to_have_count(1)
        send(page, '虚构图片与收支示例，请画本地图表。', 1)
        first='**虚构分析**：普通文字应逐片保留。'
        delta(page, first);expect(page.locator('.chat-streaming')).to_contain_text('普通文字应逐片保留')
        # Split inside the fence: incomplete structured data remains inert until complete.
        chart_text=fence(CHARTS[0]);cut=len(chart_text)//2
        delta(page, chart_text[:cut]);expect(page.locator('.chat-streaming')).to_contain_text('虚构分析')
        delta(page, chart_text[cut:]+'\n图表后面的文字。');finish(page)
        expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
        try:
            expect(page.locator('[data-chat-chart]')).to_have_count(1)
        except AssertionError:
            page.screenshot(path=str(OUT/f'failure-chart-{label}.png'),animations='disabled')
            raise
        if red:
            raise AssertionError('旧生产构建意外具备图表卡片；失败证据无效')
        expect(page.locator('.assistant')).to_contain_text('图表后面的文字')
        page.locator('[data-chat-copy="1"]').click()
        page.wait_for_function('window.__artifactCopied?.includes("图表后面的文字")')
        assert 'data:image/' not in page.evaluate('window.__artifactCopied')
        draft=wait_for_draft(page, lambda d: len(d['messages'])==2 and not d.get('chatReply'))
        assert 'data:image/' not in draft['messages'][1]['content']
        assert draft['messages'][1].get('chart')==CHARTS[0], '图表须以结构化本地数据持久化'
        image_preview(page,page.locator('[data-chat-image="0:0"]'),label)
        for i,chart in enumerate(CHARTS):
            if i:
                send(page,f'虚构第{i+1}种图表。',i+1);delta(page,'虚构样本。'+fence(chart));finish(page)
                expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
            index=i*2+1
            card=page.locator('[data-chat-chart]').nth(i)
            expect(card).to_contain_text(chart['title'])
            table=card.locator('table')
            if not table.is_visible():
                summary=card.locator('summary');expect(summary).to_have_count(1)
                summary.focus();summary.press('Enter')
            expect(table).to_be_visible()
            for value in chart['labels']+[s['name'] for s in chart['series']]:
                expect(table).to_contain_text(value)
            if i==0:
                expect(table).to_contain_text('123.45');expect(table).to_contain_text('-25');expect(table).to_contain_text('0')
            hit=card.locator('[data-chart-hit="1"]').first
            hit.scroll_into_view_if_needed()
            if hit.evaluate('e=>e.tagName.toLowerCase()==="path"'):
                # The center of a hollow SVG arc's bounding box is not on its stroke.
                point=hit.evaluate('e=>{const p=e.getPointAtLength(e.getTotalLength()/2),q=new DOMPoint(p.x,p.y).matrixTransform(e.getScreenCTM());return {x:q.x,y:q.y}}')
                if width<600:
                    page.touchscreen.tap(point['x'],point['y'])
                else:
                    page.mouse.click(point['x'],point['y'])
            elif width<600:
                hit.tap()
            else:
                hit.click()
            expect(card.locator('[data-chat-chart-value]')).to_contain_text(chart['labels'][1])
            picker=card.get_by_role('group',name='选择分类').get_by_role('button')
            picker.first.focus();picker.first.press('End')
            expect(picker.last).to_be_focused();expect(picker.last).to_have_attribute('aria-pressed','true')
            expect(card.locator('[data-chat-chart-value]')).to_contain_text(chart['labels'][-1])
            picker.last.press('Home');expect(picker.first).to_be_focused()
            download_png(page,page.locator(f'[data-chat-chart-save="{index}"]'),f'{chart["type"]}-{label}.png')
            share_png(page,page.locator(f'[data-chat-chart-share="{index}"]'),cancel=i==1)
            page.locator('#toast.show').wait_for(state='hidden')
            # A tall card lives in an overflow-y scroller; an element screenshot
            # would crop its plot. Capture its actual top and tail viewports.
            card.evaluate('''el=>{const p=document.querySelector('#life-chat-messages');p.scrollTo({top:p.scrollTop+el.getBoundingClientRect().top-p.getBoundingClientRect().top,behavior:'instant'})}''')
            page.screenshot(path=str(OUT/f'card-{chart["type"]}-{label}.png'),animations='disabled')
            card.evaluate('''el=>{const p=document.querySelector('#life-chat-messages');p.scrollTo({top:p.scrollTop+el.getBoundingClientRect().bottom-p.getBoundingClientRect().bottom,behavior:'instant'})}''')
            page.screenshot(path=str(OUT/f'card-tail-{chart["type"]}-{label}.png'),animations='disabled')
        layout(page,label)
        no_automatic_writes(page,before)
        # Persist, reopen and reload the real conversation, rather than re-rendering fixtures.
        leave(page);enter(page);expect(page.locator('[data-chat-chart]')).to_have_count(3)
        page.reload();page.locator('#fab').wait_for();page.locator('[data-page="page-life"]').click()
        appearance(page,theme,scale);enter(page)
        expect(page.locator('[data-chat-chart]')).to_have_count(3)
        image_preview(page,page.locator('[data-chat-image="0:0"]'),f'restored-{label}',close='back',export=False)
        no_automatic_writes(page,before)
        if width==390 and scale==1:
            adversarial(page)
            save_and_reopen(page, before, label)
        assert not external, external
        assert not errors, errors
        print('PASS chat artifacts',label,flush=True)
    except Exception:
        page.screenshot(path=str(OUT/f'failure-{label}.png'),animations='disabled')
        print('ARTIFACT_FAILURE',label,page.evaluate('({active:document.activeElement?.tagName,activeId:document.activeElement?.id,sheet:document.querySelector("#sheet")?.innerText})'),flush=True)
        raise
    finally:
        context.close()


def adversarial(page):
    before=page.locator('[data-chat-chart]').count()
    malicious=('```gleam-chart\n{"version":1,"type":"bar","labels":[],"series":[]}\n```\n'
        '```gleam-chart\n{invalid JSON}\n```\n'
        '```python\nwindow.__artifactExecuted = 1\nprint("do not execute")\n```\n'
        '<img src="https://artifact.invalid/x" onerror="window.__artifactExecuted=2">\n'
        '<script>window.__artifactExecuted=3</script>\n'
        '[危险地址](javascript:window.__artifactExecuted=4)\n'
        '```gleam-chart\n{"version":1,"type":"bar","title":"https://artifact.invalid/chart","labels":["x"],"series":[{"name":"x","values":["https://artifact.invalid/y"]}]}\n```')
    send(page,'虚构安全显示样本。',1);delta(page,malicious);finish(page)
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    expect(page.locator('[data-chat-chart]')).to_have_count(before)
    expect(page.locator('.assistant').last.locator('pre').filter(has_text='{invalid JSON}')).to_have_count(1)
    expect(page.locator('.assistant').last.locator('pre').filter(has_text='window.__artifactExecuted = 1')).to_have_count(1)
    assert not page.evaluate('window.__artifactExecuted')
    expect(page.locator('.assistant script,.assistant iframe,.assistant img[src^="http"],.assistant a[href^="javascript:"]')).to_have_count(0)


def save_and_reopen(page, before, label):
    # Summary is an explicit user operation; only its final Save may create a note.
    summary={'title':'虚构图表正式记录','body':'本地图表与照片应跟随原始会话保留。','tags':['虚构'],'sourceMessageCount':8}
    page.route('https://life-ai.invalid/**',lambda r:r.fulfill(json={'choices':[{'message':{'content':json.dumps(summary,ensure_ascii=False)}}]}))
    # The streaming mock is disabled only for this one simulated JSON summary call.
    page.evaluate('''()=>{const fetch=window.fetch;window.fetch=(url,options)=>{
      if(String(url).startsWith('https://life-ai.invalid/')&&!JSON.parse(options.body).stream){
        return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({title:'虚构图表正式记录',body:'本地图表与照片应跟随原始会话保留。',tags:['虚构'],sourceMessageCount:8})}}]}),{headers:{'Content-Type':'application/json'}}));
      }return fetch(url,options);
    }}''')
    page.locator('[data-chat-organize]').click()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('[data-life-summary-save]').wait_for()
    no_automatic_writes(page,before)
    page.locator('[data-life-summary-save]').click()
    page.locator('#sp-life-chat').wait_for(state='detached')
    saved=next(n for n in read_rows(page,'lifeNotes') if n.get('title')==summary['title'])
    assert len(saved['conversation'])==8
    assert saved['conversation'][0].get('photoRefs') and not saved['conversation'][0].get('photos')
    for i,chart in enumerate(CHARTS):
        assert saved['conversation'][i*2+1].get('chart')==chart
    for name in ['entries','accounts']:
        assert read_rows(page,name)==before[name]
    for note in before['lifeNotes']:
        assert next(n for n in read_rows(page,'lifeNotes') if n['id']==note['id'])==note
    page.locator(f'[data-note="{saved["id"]}"]').click();page.locator('[data-lc-view-conversation]').click()
    expect(page.locator('[data-chat-chart]')).to_have_count(3)
    image_preview(page,page.locator('[data-chat-image="0:0"]'),f'formal-{label}',close='back')


def official_images(browser, native=False):
    """Imported assistant attachments and a missing reference use the same safe viewer."""
    context,page,external,errors=setup(browser,390,844,'light',1,native=native)
    try:
        leave(page)
        photo=page.evaluate(PHOTO)
        page.evaluate('''async photo=>{
          const blob=await(await fetch(photo)).blob();
          const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
          const tx=db.transaction(['attachments','lifeNotes'],'readwrite'),stamp={createdAt:1,updatedAt:1};
          tx.objectStore('attachments').put({...stamp,id:7001,blob,mime:blob.type,size:blob.size,name:'fictional-import.png'});
          tx.objectStore('lifeNotes').put({...stamp,id:7001,kind:'photo',title:'虚构助手图片引用',body:'只读附件回归',occurredAt:Date.now(),deletedAt:0,photoRefs:[7001],
            conversation:[{role:'user',content:'虚构查看照片请求',photoRefs:[7001]},{role:'assistant',content:'虚构助手已保存的图片引用。',photoRefs:[7001,7999]}]});
          await new Promise(resolve=>tx.oncomplete=resolve);db.close();
        }''',photo)
        page.reload();page.locator('#fab').wait_for();page.locator('[data-page="page-life"]').click()
        page.locator('[data-note="7001"]').click();page.locator('[data-lc-view-conversation]').click()
        trigger=page.locator('[data-chat-image="1:0"]');expect(trigger).to_be_visible()
        before={name:read_rows(page,name) for name in ['entries','accounts','lifeNotes']}
        if native:
            trigger.click();sheet=page.locator('#sheet.open[aria-label="图片预览"]')
            expect(sheet.get_by_role('button',name='分享图片')).to_be_enabled()
            for cancel in [False,True]:
                page.evaluate('cancel=>window.__nativeCancelImage=cancel',cancel)
                previous=page.evaluate('window.__nativeImageCalls.filter(c=>c.method==="share").length')
                sheet.get_by_role('button',name='分享图片').click()
                page.wait_for_function('n=>window.__nativeImageCalls.filter(c=>c.method==="share").length===n+1',arg=previous)
                expect(sheet.get_by_role('button',name='分享图片')).to_be_enabled()
                calls=page.evaluate('window.__nativeImageCalls')
                writes=[c for c in calls if c['method']=='writeFile']
                assert writes[-1]['directory']=='CACHE' and writes[-1]['path'].startswith('chat-images/'),writes[-1]
                assert not any(c.get('directory')=='DOCUMENTS' for c in calls)
                check_png(page,base64.b64decode(writes[-1]['data']),photo=True)
                assert calls[-1]['method']==('deleteFile' if cancel else 'share'),calls[-1]
                assert '失败' not in sheet.inner_text()
            page.evaluate('window.__nativeCancelImage=false')
            sheet.get_by_role('button',name='保存图片').click()
            expect(sheet).to_contain_text('已保存到')
            writes=page.evaluate('window.__nativeImageCalls.filter(c=>c.method==="writeFile")')
            assert writes[-1]['directory']=='DOCUMENTS'
            check_png(page,base64.b64decode(writes[-1]['data']),photo=True)
            page.keyboard.press('Escape')
        else:
            image_preview(page,trigger,'assistant-reference',close='back')
            missing=page.locator('[data-chat-image="1:1"]');missing.click()
            sheet=page.locator('#sheet.open[aria-label="图片预览"]')
            expect(sheet).to_contain_text('图片已删除或不存在')
            expect(sheet.get_by_role('button',name='保存图片')).to_be_disabled()
            expect(sheet.get_by_role('button',name='分享图片')).to_be_disabled()
            page.keyboard.press('Escape');expect(missing).to_be_focused()
            # Delay a real IndexedDB attachment read, then close while it is pending.
            page.evaluate('''()=>{
              const get=IDBObjectStore.prototype.get,success=Object.getOwnPropertyDescriptor(IDBRequest.prototype,'onsuccess');
              window.__artifactPendingReads=0;
              IDBObjectStore.prototype.get=function(...args){
                const r=get.apply(this,args);if(this.name!=='attachments')return r;
                window.__artifactPendingReads++;let listener;
                Object.defineProperty(r,'onsuccess',{configurable:true,get:()=>listener,set(callback){listener=callback;success.set.call(r,function(event){setTimeout(()=>{window.__artifactPendingReads--;callback.call(r,event)},250)})}});
                return r;
              };
            }''')
            baseline=page.evaluate('window.__artifactUrlsCreated')
            trigger.click();sheet=page.locator('#sheet.open[aria-label="图片预览"]')
            expect(sheet).to_contain_text('正在读取图片')
            assert page.evaluate('window.__artifactPendingReads')>0
            sheet.get_by_role('button',name='关闭图片预览').click()
            page.wait_for_function('window.__artifactPendingReads===0')
            expect(page.locator('#sheet')).to_have_attribute('aria-hidden','true')
            assert page.evaluate('window.__artifactUrlsCreated')==baseline,'关闭后异步图片不应再创建对象URL'
            expect(trigger).to_be_focused()
            # A normal open owns one additional URL, released immediately on close.
            active=page.evaluate('window.__artifactUrls')
            trigger.click();expect(page.locator('#sheet [data-image-save]')).to_be_enabled()
            opened=[url for url in page.evaluate('window.__artifactUrls') if url not in active]
            assert len(opened)==1
            page.keyboard.press('Escape')
            assert opened[0] not in page.evaluate('window.__artifactUrls')
        no_automatic_writes(page,before)
        assert not external,external
        assert not errors,errors
        print('PASS chat imported assistant images', 'native mock' if native else 'web async lifecycle',flush=True)
    except Exception:
        page.screenshot(path=str(OUT/f'failure-imported-{"native" if native else "web"}.png'),animations='disabled')
        raise
    finally:
        context.close()


def confirmed_ledger_chart(browser, width):
    """The consent UI, real local aggregation and chart renderer agree despite a forged model chart."""
    context,page,external,errors=setup(browser,width,844,'light',1)
    try:
        page.clock.set_fixed_time('2026-07-02T12:00:00Z')
        seed_ledger(page)
        snapshot=ledger_snapshot(page)
        notes=read_rows(page,'lifeNotes')
        page.locator('#life-chat-input').fill('把我最近六个月收支画成柱状图')
        page.locator('[data-life-chat-send]').click()
        ready(page,'trend')
        assert page.evaluate('window.__chatRequests.length')==0, '确认范围前不应请求模型'
        page.locator('[data-ledger-prev]').click()
        page.locator('[data-ledger-period="calendar"]').click()
        page.locator('[data-ledger-analysis="trend"]').click()
        page.locator('[data-ledger-income]').check()
        assert_scope(page,'2026-06','trend',income=True)
        preview=page.locator('[data-ledger-preview]').inner_text()
        for month in MONTHS:
            assert month in preview
        assert page.evaluate('window.__chatRequests.length')==0, '本机改选范围不得发送AI请求'
        assert_read_only(page,snapshot)
        page.locator('[data-ledger-approve]').click()
        page.wait_for_function('window.__chatRequests.length===1')
        payload=page.evaluate('window.__chatRequests[0].payload')
        summary=ledger_summary(payload)
        assert summary['scope']=={'month':'2026-06','period':'calendar','includeIncome':True,'analysis':'trend'}
        periods=summary['analysis']['periods']
        assert [period['scope']['month'] for period in periods]==MONTHS
        assert [period['totals']['expenseFen'] for period in periods]==NETS
        assert [period['income']['incomeFen'] for period in periods]==[80000]*6
        forged={'version':1,'type':'bar','title':'模型伪造金额，不可采信','labels':MONTHS,
            'series':[{'name':'净支出','values':[99999999]*6},{'name':'收入','values':[88888888]*6}],
            'unit':'元','valueDivisor':100}
        delta(page,'虚构模型解释。'+fence(forged));finish(page)
        expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
        card=page.locator('[data-chat-chart]');expect(card).to_have_count(1)
        expect(card).to_contain_text('本机账本快照 · 本次确认范围')
        expected={'version':1,'type':'bar','title':'2026-06 自然月 · 近6月收支','labels':MONTHS,
            'series':[{'name':'净支出','values':NETS},{'name':'收入','values':[80000]*6}],
            'unit':'元','valueDivisor':100}
        draft=wait_for_draft(page,lambda d:len(d['messages'])==2 and not d.get('chatReply'))
        assert draft['messages'][1].get('chart')==expected
        assert draft['messages'][1]['chart']!=forged
        card.locator('summary').click()
        rows=card.locator('tbody tr')
        expect(rows).to_have_count(6)
        for i,(month,net) in enumerate(zip(MONTHS,NETS)):
            assert rows.nth(i).locator('th,td').all_text_contents()==[month,f'{net/100:,.2f}元','800.00元']
        assert '999999' not in card.inner_text() and '888888' not in card.inner_text()
        assert card.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
        for tail in [False,True]:
            card.evaluate('''(el,tail)=>{const p=document.querySelector('#life-chat-messages'),r=el.getBoundingClientRect(),s=p.getBoundingClientRect();p.scrollTo({top:p.scrollTop+(tail?r.bottom-s.bottom:r.top-s.top),behavior:'instant'})}''',tail)
            page.screenshot(path=str(OUT/f'ledger-chart-{"tail" if tail else "top"}-{width}.png'),animations='disabled')
        assert_read_only(page,snapshot)
        assert read_rows(page,'lifeNotes')==notes
        page.reload();page.locator('#fab').wait_for();watch_writes(page)
        page.locator('[data-page="page-life"]').click();enter(page)
        expect(page.locator('[data-chat-chart]')).to_have_count(1)
        expect(page.locator('[data-chat-chart]')).to_contain_text(expected['title'])
        restored=next(d for d in read_rows(page,'lifeDrafts') if len(d.get('messages',[]))==2)
        assert restored['messages'][1]['chart']==expected
        assert page.evaluate('window.__chatRequests.length')==0,'刷新不得自动重新请求账本或模型'
        assert_read_only(page,snapshot)
        assert read_rows(page,'lifeNotes')==notes
        assert not external,external
        assert not errors,errors
        print('PASS confirmed local ledger chart',width,flush=True)
    except Exception:
        page.screenshot(path=str(OUT/f'failure-ledger-chart-{width}.png'),animations='disabled')
        raise
    finally:
        context.close()


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    red=os.environ.get('GLEAM_ARTIFACT_RED')=='1'
    ledger_only=os.environ.get('GLEAM_ARTIFACT_LEDGER_ONLY')=='1'
    configs=[(390,844,'light',1)] if red else [
        (360,844,'light',1),(390,844,'dark',1),(430,844,'light',1),
        (1280,900,'dark',1),(390,640,'dark',1.3)]
    with sync_playwright() as p:
        browser=p.chromium.launch()
        try:
            if not ledger_only:
                for config in configs:
                    run(browser,*config,red=red)
                if not red:
                    official_images(browser)
                    official_images(browser,native=True)
            if not red:
                for width in (390,1280):
                    confirmed_ledger_chart(browser,width)
        finally:
            browser.close()
