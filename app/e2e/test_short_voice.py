"""百炼短语音：合成原生桥、虚构账单、模拟文字模型；绝不调用麦克风或真实服务。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_browser_usability import assert_usable
from test_life_ai import read_rows

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/short-voice'
MOCK_NATIVE = r'''(() => {
  window.__voiceCalls = []; window.__voiceHasKey = false; window.__voiceRevision = 0;
  window.__voiceText = '今天午餐28.01元，现金'; window.__voiceError = null;
  window.__voicePending = new Map(); window.__voiceListeners = new Map();
  window.__micCalls = 0;
  navigator.mediaDevices.getUserMedia = async () => { window.__micCalls++; throw new Error('REAL_MIC_FORBIDDEN'); };
  const methods = (names, callbacks=[]) => [...names.map(name => ({name,rtype:'promise'})), ...callbacks.map(name => ({name,rtype:'callback'}))];
  const secret = {'ai.apiKey':'synthetic-text-test-key'};
  const configuration = () => ({supported:true,hasKey:window.__voiceHasKey,credentialRevision:String(window.__voiceRevision)});
  window.androidBridge = {};
  window.Capacitor = {
    PluginHeaders: [
      {name:'GleamSpeech',methods:methods(['configuration','setKey','clearKey','start','stop','cancel'],['addListener','removeListener'])},
      {name:'GleamSecrets',methods:methods(['get','set','remove'])},
      {name:'GleamEntry',methods:methods(['setShortcuts','updateWidget'])},
      {name:'App',methods:methods(['getLaunchUrl','exitApp'],['addListener','removeListener'])},
    ],
    nativeCallback(plugin, method, options, callback) {
      if (plugin === 'GleamSpeech' && method === 'addListener') {
        const id = 'listener-'+window.__voiceListeners.size; window.__voiceListeners.set(id,callback); return id;
      }
      if (plugin === 'GleamSpeech' && method === 'removeListener') window.__voiceListeners.delete(options.callbackId);
      return 'mock-listener';
    },
    async nativePromise(plugin, method, options) {
      if (plugin === 'GleamSecrets') {
        if (method === 'get') return {value:secret[options.key]||null};
        if (method === 'set') secret[options.key]=options.value;
        if (method === 'remove') delete secret[options.key];
        return {};
      }
      if (plugin !== 'GleamSpeech') return {};
      window.__voiceCalls.push({method,...(method==='setKey'?{redacted:true}:options||{})});
      if (method === 'configuration') return configuration();
      if (method === 'setKey' || method === 'clearKey') {
        if (method === 'setKey' && window.__delayVoiceKey) await new Promise(resolve => {window.__resolveVoiceKey=resolve});
        window.__voiceHasKey=method==='setKey'; window.__voiceRevision++;
        for (const pending of window.__voicePending.values()) pending.reject({code:'SPEECH_KEY_CHANGED'});
        return configuration();
      }
      if (method === 'start') {
        if (window.__voiceError) throw {code:window.__voiceError,message:'PRIVATE_PROVIDER_ECHO'};
        if (options.expectedCredentialRevision !== String(window.__voiceRevision)) throw {code:'SPEECH_KEY_CHANGED'};
        window.__voiceListeners.forEach(callback => callback({sessionId:options.sessionId,state:'listening'}));
        return new Promise((resolve,reject) => window.__voicePending.set(options.sessionId,{resolve,reject}));
      }
      if (method === 'stop') {
        window.__voicePending.get(options.sessionId)?.resolve({sessionId:options.sessionId,text:window.__voiceText});
        return {};
      }
      // Deliberately let cancelled mock replies arrive later to exercise stale isolation.
      return {};
    },
  };
})()'''


def seed_config(page):
    page.evaluate('''async () => {
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('settings','readwrite');
      for(const [key,value] of [['ai.baseUrl','https://short-voice.invalid/v1'],['ai.model','mock-text-model'],['ai.autoConfirmThreshold',50],['voice.bailian.workspace','synthetic-workspace']]) tx.objectStore('settings').put({key,value,updatedAt:1});
      await new Promise(resolve=>tx.oncomplete=resolve);db.close();
    }''')


def open_entry_voice(page):
    page.locator('#fab').click(); page.locator('#keypad').wait_for();
    page.locator('#btn-voice').click(); page.locator('[data-sv-text]').wait_for()


def image(page, name, width):
    page.locator('#toast.show').wait_for(state='hidden'); page.wait_for_timeout(150)
    assert_usable(page, '.short-voice-panel')
    page.screenshot(path=str(OUT / f'{name}-{width}.png'), animations='disabled')


def run(page, width):
    errors, requests, payloads = [], [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(MOCK_NATIVE)
    page.route('https://**/*', lambda route: route.abort())
    def model(route):
        payloads.append(route.request.post_data_json)
        route.fulfill(json={'choices':[{'message':{'content':'[{"type":"expense","amount":"28.01","category":"餐饮/午餐","account":"现金","time":"2026-10-03 12:00","note":"虚构午餐","confidence":100}]'}}]})
    page.route('https://short-voice.invalid/**', model)
    page.on('request', lambda req: requests.append(req.url) if req.url.startswith('https://') else None)
    page.goto(URL); page.locator('#fab').wait_for(); seed_config(page)
    page.locator('[data-page="page-mine"]').click(); page.locator('[data-sub="sp-settings"]').click()
    page.locator('#voice-bailian-key').wait_for(); page.locator('#voice-bailian-key').scroll_into_view_if_needed()
    expect(page.locator('#voice-bailian-key')).to_be_enabled()
    expect(page.locator('#voice-bailian-key')).to_have_value('')
    page.locator('#voice-bailian-key').fill('synthetic-voice-test-key')
    page.evaluate('window.__delayVoiceKey=true')
    page.locator('[data-voice-save-key]').click()
    expect(page.locator('#voice-bailian-key')).to_have_value('')
    # Intervening settings refresh must not resurrect Key or permit duplicate saves.
    page.evaluate("window.__oldVoiceInput=document.querySelector('#voice-bailian-key')")
    page.locator('#voice-bailian-workspace').fill('changed-workspace')
    page.locator('#voice-bailian-workspace').press('Tab')
    page.wait_for_function("document.querySelector('#voice-bailian-key')!==window.__oldVoiceInput")
    expect(page.locator('#voice-bailian-key')).to_be_disabled()
    expect(page.locator('#voice-bailian-key')).to_have_value('')
    page.evaluate('window.__delayVoiceKey=false;window.__resolveVoiceKey()')
    expect(page.locator('[data-voice-key-status]')).to_contain_text('已保存')
    expect(page.locator('#voice-bailian-key')).to_have_value('')
    page.locator('#voice-bailian-workspace').fill('synthetic-workspace')
    page.locator('#voice-bailian-workspace').press('Tab')
    assert not requests
    assert not any('synthetic-voice-test-key' in str(row) for row in read_rows(page,'settings'))
    assert page.evaluate("!JSON.stringify({...localStorage,...sessionStorage}).includes('synthetic-voice-test-key')")
    page.screenshot(path=str(OUT / f'settings-{width}.png'), animations='disabled')
    page.locator('[data-voice-clear-key]').click()
    expect(page.locator('[data-voice-key-status]')).to_contain_text('只保存在')
    page.locator('#voice-bailian-key').fill('synthetic-voice-test-key')
    page.locator('[data-voice-save-key]').click(); expect(page.locator('[data-voice-key-status]')).to_contain_text('已保存')
    page.locator('#sp-settings [data-act="back"]').click()
    page.locator('[data-page="page-home"]').click()

    # Opening never captures/sends; dismiss keeps every underlying draft field.
    page.locator('#fab').click(); page.locator('#note').fill('原本的虚构草稿');
    page.locator('#keypad [data-k="9"]').click(); page.locator('#btn-voice').click()
    expect(page.locator('[data-sv-start]')).to_be_enabled()
    expect(page.locator('[data-sv-consent]')).to_contain_text('阿里云百炼')
    expect(page.locator('[data-sv-consent]')).to_contain_text('synthetic-workspace.cn-beijing.maas.aliyuncs.com')
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').length") == 0
    image(page, 'consent', width)
    page.locator('[data-sv-close]').click(); expect(page.locator('#note')).to_have_value('原本的虚构草稿')
    expect(page.locator('#amt')).to_contain_text('9.00'); page.locator('#sheet-close').click()

    open_entry_voice(page)
    page.locator('[data-sv-start]').click(); expect(page.locator('[data-sv-status]')).to_contain_text('正在听')
    page.locator('[data-sv-start]').dispatch_event('click')
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').length") == 1
    image(page, 'listening', width)
    page.locator('[data-sv-stop]').click(); expect(page.locator('[data-sv-text]')).to_have_value('今天午餐28.01元，现金')
    assert not payloads
    page.locator('[data-sv-text]').fill('核对后午餐28.01元，现金')
    page.locator('[data-sv-preview]').click(); expect(page.locator('[data-sv-send-panel]')).to_be_visible()
    assert not payloads; image(page, 'text-consent', width)
    page.locator('[data-sv-text]').fill('最终核对午餐28.01元，现金')
    expect(page.locator('[data-sv-send-panel]')).to_be_hidden()
    page.locator('[data-sv-preview]').click(); page.locator('[data-sv-send]').click()
    expect(page.locator('[data-sv-result]')).to_be_visible(); image(page, 'draft', width)
    assert payloads[-1]['messages'][1]['content'] == '最终核对午餐28.01元，现金'
    assert len(read_rows(page,'entries')) == 0
    page.locator('[data-sv-apply]').click(); expect(page.locator('[data-sv-text]')).to_have_count(0)
    expect(page.locator('#amt')).to_contain_text('28.01')
    page.locator('#keypad [data-k="save"]').click()
    page.locator('#keypad [data-k="save"]').dispatch_event('click') if page.locator('#keypad [data-k="save"]').count() else None
    page.locator('#sheet.open').wait_for(state='hidden')
    rows=read_rows(page,'entries'); assert len(rows)==1 and rows[0]['amount']==2801

    # Cancelled and replaced sessions cannot apply late text; private provider errors stay private.
    open_entry_voice(page); page.locator('[data-sv-start]').click()
    expect(page.locator('[data-sv-status]')).to_contain_text('正在听')
    old=page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').at(-1).sessionId")
    page.locator('[data-sv-cancel]').click(); page.locator('[data-sv-text]').fill('取消后的手改文字')
    page.evaluate("id=>window.__voicePending.get(id).resolve({sessionId:id,text:'迟到文本'})",old)
    expect(page.locator('[data-sv-text]')).to_have_value('取消后的手改文字')
    page.evaluate("window.__voiceError='SPEECH_PERMISSION_DENIED'")
    page.locator('[data-sv-start]').click(); expect(page.locator('[data-sv-status]')).to_contain_text('麦克风未获授权')
    assert 'PRIVATE_PROVIDER_ECHO' not in page.locator('.short-voice-panel').inner_text()
    image(page,'permission-error',width)
    page.locator('[data-sv-close]').click(); page.locator('#sheet-close').click()
    page.evaluate('window.__voiceError=null')

    # High-confidence voice draft remains ready until an explicit inbox confirmation.
    page.locator('[data-qa="ai"]').click()
    page.locator('#ai-text').fill('原本尚未发送的收件箱虚构草稿')
    page.locator('[data-act="short-voice"]').click()
    page.locator('[data-sv-text]').fill('虚构午餐28.01元现金')
    page.locator('[data-sv-preview]').click(); page.locator('[data-sv-send]').click()
    expect(page.locator('[data-sv-result]')).to_be_visible(); page.locator('[data-sv-apply]').click()
    expect(page.locator('.short-voice-mask')).to_have_count(0)
    expect(page.locator('#ai-text')).to_have_value('原本尚未发送的收件箱虚构草稿')
    queue=next(row['value'] for row in read_rows(page,'settings') if row['key']=='ai.pendingItems')
    assert len(queue)==1 and queue[0]['source']=='voice' and queue[0]['status']=='ready'
    assert len(read_rows(page,'entries'))==1
    page.locator('.ai-card [data-act="ignore"]').click()
    assert page.evaluate('window.__micCalls')==0
    assert not errors,errors


def web_mode(page,width):
    page.goto(URL);page.locator('#fab').wait_for()
    page.locator('#fab').click();page.locator('#btn-voice').click()
    expect(page.locator('[data-sv-status]')).to_contain_text('仅支持 Android')
    expect(page.locator('[data-sv-start]')).to_be_disabled()
    image(page,'web-fallback',width)
    page.locator('[data-sv-close]').click();page.locator('#sheet-close').click()
    page.locator('[data-page="page-mine"]').click();page.locator('[data-sub="sp-settings"]').click()
    expect(page.locator('#voice-bailian-key')).to_be_disabled()
    expect(page.locator('[data-voice-key-status]')).to_contain_text('不接收或保存')


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width in (360,390,430,1280):
            context=browser.new_context(viewport={'width':width,'height':844},service_workers='block',reduced_motion='reduce')
            run(context.new_page(),width);context.close()
            web=browser.new_context(viewport={'width':width,'height':844},service_workers='block',reduced_motion='reduce')
            web_mode(web.new_page(),width);web.close()
            print(f'PASS synthetic short voice {width}',flush=True)
        browser.close()
