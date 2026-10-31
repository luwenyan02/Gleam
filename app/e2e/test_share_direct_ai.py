"""Android 分享直达 AI：模拟原生分享事件与 AI 响应，只使用合成图片。"""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import expect, sync_playwright
from test_life_ai import read_rows
from test_short_voice import MOCK_NATIVE

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/share-direct-ai'
SHARE_BRIDGE = r'''(() => {
  window.__shareHasKey = true;
  const bridge = window.Capacitor, callback = bridge.nativeCallback, promise = bridge.nativePromise;
  bridge.PluginHeaders.push({name:'CapacitorShareTarget',methods:[{name:'addListener',rtype:'callback'},{name:'removeListener',rtype:'callback'}]});
  window.__testShare = (count=1, texts=[]) => {
    const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=160;
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,320,160);
    ctx.fillStyle='#111111'; ctx.font='24px sans-serif'; ctx.fillText('TEST RECEIPT 23.00',16,80);
    window.__shareCallback({title:'虚构分享',texts,files:Array.from({length:count},(_,i)=>({
      name:`虚构截图${i+1}.png`,mimeType:'image/png',uri:canvas.toDataURL('image/png'),
    }))});
  };
  bridge.nativeCallback = (plugin, method, options, cb) => {
    if(plugin==='CapacitorShareTarget' && method==='addListener') {
      if(options.eventName!=='shareReceived') throw new Error('Unexpected share event');
      window.__shareCallback=cb;
      if(sessionStorage.getItem('test-cold-share')) {
        sessionStorage.removeItem('test-cold-share'); queueMicrotask(()=>window.__testShare());
      }
      return 'synthetic-share-listener';
    }
    return callback(plugin,method,options,cb);
  };
  bridge.nativePromise = (plugin,method,options) => {
    if(plugin==='GleamSecrets' && method==='get' && options.key==='ai.apiKey' && !window.__shareHasKey)
      return Promise.resolve({value:null});
    return promise(plugin,method,options);
  };
})()'''


def configure(page):
    page.evaluate('''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('settings','readwrite');
      for(const [key,value] of [['ai.baseUrl','https://share-ai.invalid/v1'],['ai.model','synthetic-vision'],['ai.autoConfirmThreshold',100]])
        tx.objectStore('settings').put({key,value,updatedAt:1});
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
    }''')


def queue(page):
    return next((row['value'] for row in read_rows(page, 'settings') if row['key'] == 'ai.pendingItems'), [])


def run(browser, width, missing=False):
    context = browser.new_context(viewport={'width': width, 'height': 890}, device_scale_factor=3 if width == 400 else 1,
                                  has_touch=True, is_mobile=width < 600, service_workers='block')
    context.add_init_script(MOCK_NATIVE + ';\n' + SHARE_BRIDGE)
    requests, unexpected, errors = [], [], []

    def route_request(route):
        host = urlsplit(route.request.url).netloc
        if host == urlsplit(URL).netloc:
            return route.continue_()
        if host != 'share-ai.invalid':
            unexpected.append(host)
            return route.abort()
        data = route.request.post_data_json
        requests.append(data)
        bill = [{'type':'expense','amount':'23.00','category':'餐饮/午餐','account':'现金',
                 'time':'2026-10-31 12:00','note':'虚构午餐','confidence':80}]
        route.fulfill(json={'choices':[{'message':{'content':json.dumps(bill, ensure_ascii=False)}}]})

    context.route('**/*', route_request)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL); page.locator('#fab').wait_for(); page.wait_for_function('!!window.__shareCallback')
    entries_before = read_rows(page, 'entries')
    if missing:
        page.evaluate('window.__shareHasKey=false; window.__testShare()')
        expect(page.locator('#sp-ai-inbox.open:not([inert])')).to_be_visible()
        expect(page.locator('.ai-guide')).to_contain_text('先设置 AI 记账')
        expect(page.locator('.ai-card.raw')).to_contain_text('等待识别')
        pending = queue(page)
        assert len(pending) == 1 and pending[0]['status'] == 'pending', pending
        assert pending[0]['attachmentId'] and len(read_rows(page, 'attachments')) == 1
        assert not requests
        page.screenshot(path=str(OUT / 'missing-config-400.png'), animations='disabled')
        configure(page); page.evaluate('window.__shareHasKey=true')
        page.locator('[data-act="retry"]').click()
        expect(page.locator('#sp-ai-inbox.open:not([inert]) .ai-card:not(.raw)')).to_have_count(1)
        assert len(requests) == 1
    else:
        configure(page)
        if width == 400:
            # 插件在冷启动监听注册时补发缓存事件，应用无需再点击任何入口。
            page.evaluate("sessionStorage.setItem('test-cold-share','1')")
            page.reload()
        else:
            page.evaluate('window.__testShare()')
        expect(page.locator('#sp-ai-inbox.open:not([inert])')).to_be_visible()
        expect(page.locator('#sp-ai-inbox.open:not([inert]) .ai-card:not(.raw)')).to_have_count(1)
        assert len(requests) == 1
        assert any(part.get('type') == 'image_url' for part in requests[0]['messages'][-1]['content'])
        page.locator('#toast.show').wait_for(state='hidden')
        page.screenshot(path=str(OUT / f'direct-{width}.png'), animations='disabled')
        if width == 400:
            # 已打开收件箱时连续分享多张图片和文字，素材不丢失、不重复识别。
            page.evaluate("window.__testShare(2); window.__testShare(0,['虚构午餐 23 元'])")
            expect(page.locator('#sp-ai-inbox.open:not([inert]) .ai-card:not(.raw)')).to_have_count(4)
            assert len(requests) == 4 and len(queue(page)) == 4
            assert len(read_rows(page, 'attachments')) == 3
    expect(page.get_by_text('如何使用分享图片', exact=True)).to_have_count(0)
    assert all(item['source'] == 'share' and item['status'] == 'ready' for item in queue(page))
    assert read_rows(page, 'entries') == entries_before, '沿用自动入账门槛，不得绕过配置直接写入账本'
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    assert page.locator('#sp-ai-inbox.open:not([inert])').evaluate('el=>el.scrollWidth<=el.clientWidth+1')
    assert not errors, errors
    assert not unexpected, unexpected
    context.close()
    print('PASS direct share', width, 'missing configuration + retry' if missing else 'configured', flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in [360, 390, 400, 430, 1280]:
            run(browser, width)
        run(browser, 400, missing=True)
        browser.close()
