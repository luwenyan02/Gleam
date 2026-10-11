"""百炼短语音：合成原生桥、虚构账单、模拟文字模型；绝不调用麦克风或真实服务。"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_browser_usability import assert_usable
from test_life_ai import read_rows

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/short-voice'
MOCK_NATIVE = r'''(() => {
  // This is a synthetic native contract, not evidence of Android storage/transport behavior.
  window.__voiceCalls = []; window.__secretCalls = []; window.__voiceHasKey = false;
  window.__voiceRevision = 0; window.__mainRevision = 0; window.__voiceCommitCount = 0;
  window.__voiceCommitOutcomes = []; window.__voiceConfigurationId = null;
  window.__voiceText = '今天午餐28.01元，现金'; window.__voiceError = null;
  window.__voicePending = new Map(); window.__voiceListeners = new Map();
  window.__micCalls = 0;
  window.__appInfoCalls = 0;
  navigator.mediaDevices.getUserMedia = async () => { window.__micCalls++; throw new Error('REAL_MIC_FORBIDDEN'); };
  const methods = (names, callbacks=[]) => [...names.map(name => ({name,rtype:'promise'})), ...callbacks.map(name => ({name,rtype:'callback'}))];
  const secret = {'ai.apiKey':'synthetic-text-test-key'};
  let savedKey = '', source = 'separate', activeConfig, committedMainRevision, candidate;
  const mask = value => !value ? '' : value.length > 15 ? value.slice(0,5)+'••••••'+value.slice(-5) : '••••••';
  const effectiveKey = () => source === 'shared' && committedMainRevision !== String(window.__mainRevision)
    ? '' : savedKey || (window.__voiceHasKey ? 'synthetic-legacy-voice-key' : '');
  const configuration = () => ({
    supported:true, hasKey:!!effectiveKey(), credentialRevision:String(window.__voiceRevision),
    keySource:source, maskedKey:mask(effectiveKey()), maskedMainKey:mask(secret['ai.apiKey']),
    hasMainKey:!!secret['ai.apiKey'], mainCredentialRevision:String(window.__mainRevision),
    ...(activeConfig ? {activeConfig:{...activeConfig}} : {}),
  });
  // Inspection exposes only the same non-secret snapshot as the application bridge.
  window.__voiceSnapshot = configuration;
  function mainChanged() {
    window.__mainRevision++; window.__voiceRevision++; candidate = undefined;
    for (const pending of window.__voicePending.values()) pending.reject({code:'SPEECH_KEY_CHANGED'});
  }
  function checkRevision(options) {
    if (options.expectedCredentialRevision !== String(window.__voiceRevision)
      || options.expectedMainCredentialRevision !== String(window.__mainRevision)) throw {code:'SPEECH_KEY_CHANGED'};
    if (options.configurationId !== window.__voiceConfigurationId) throw {code:'SPEECH_SESSION_INVALID'};
  }
  window.androidBridge = {};
  window.Capacitor = {
    PluginHeaders: [
      {name:'GleamSpeech',methods:methods(['configuration','setKey','clearKey','invalidateConfiguration','testCandidate','commitTestedKey','testConnection','start','stop','cancel'],['addListener','removeListener'])},
      {name:'GleamSecrets',methods:methods(['get','set','remove'])},
      {name:'GleamEntry',methods:methods(['setShortcuts','updateWidget'])},
      {name:'App',methods:methods(['getInfo','getLaunchUrl','exitApp'],['addListener','removeListener'])},
    ],
    nativeCallback(plugin, method, options, callback) {
      if (plugin === 'GleamSpeech' && method === 'addListener') {
        const id = 'listener-'+window.__voiceListeners.size; window.__voiceListeners.set(id,callback); return id;
      }
      if (plugin === 'GleamSpeech' && method === 'removeListener') window.__voiceListeners.delete(options.callbackId);
      return 'mock-listener';
    },
    async nativePromise(plugin, method, options={}) {
      if (plugin === 'App' && method === 'getInfo') {
        window.__appInfoCalls++;
        if (window.__appInfoFailure) throw new Error('synthetic package info unavailable');
        return {name:'拾光',id:'com.gleam.shiguang',build:'synthetic-build',version:window.__appVersion ?? __MOCK_APP_VERSION__};
      }
      if (plugin === 'GleamSecrets') {
        window.__secretCalls.push({method,key:options.key});
        if (options.key.startsWith('voice.bailian.')) throw {code:'VOICE_SECRET_READBACK_FORBIDDEN'};
        if (method === 'get') return {value:secret[options.key]||null};
        if (method === 'set') secret[options.key]=options.value;
        if (method === 'remove') delete secret[options.key];
        if (options.key === 'ai.apiKey' && ['set','remove'].includes(method)) mainChanged();
        return {};
      }
      if (plugin !== 'GleamSpeech') return {};
      const {value, ...safeOptions} = options;
      window.__voiceCalls.push({method,...safeOptions,...(method==='testCandidate'?{hasValue:Object.hasOwn(options,'value')}:{}),...(value===undefined?{}:{redacted:true})});
      if (method === 'configuration') {
        const result = configuration();
        if (window.__holdNextConfiguration) {
          window.__holdNextConfiguration = false;
          return new Promise(resolve => {window.__finishConfiguration=()=>resolve(result)});
        }
        return result;
      }
      if (method === 'setKey' || method === 'clearKey' || method === 'testConnection') throw {code:'LEGACY_VOICE_MUTATION_FORBIDDEN'};
      if (method === 'invalidateConfiguration') {
        window.__voiceConfigurationId = options.configurationId; candidate = undefined; return {};
      }
      if (method === 'testCandidate') {
        checkRevision(options);
        if (options.consent !== true || options.userInitiated !== true) throw {code:'SPEECH_CONSENT_REQUIRED'};
        if (!['shared','separate'].includes(options.keySource)) throw {code:'SPEECH_CONFIG_INVALID'};
        if (options.keySource === 'shared' && Object.hasOwn(options,'value')) throw {code:'SPEECH_CONFIG_INVALID'};
        // Shared credentials are read here, inside the mock native store, never forwarded by JS.
        const key = options.keySource === 'shared' ? secret['ai.apiKey'] : value || (source === 'separate' ? effectiveKey() : '');
        if (!key) throw {code:'SPEECH_KEY_REQUIRED'};
        if (window.__testError) throw {code:window.__testError,data:{phase:'configuring',reason:'ACK_MODEL_MISMATCH',reasons:window.__testReasons ?? ['ACK_MODEL_MISMATCH','ACK_AUDIO_FORMAT_MISSING','PRIVATE_UNKNOWN_REASON']},message:'PRIVATE_PROVIDER_BODY'};
        const token = 'synthetic-candidate-'+options.sessionId;
        candidate = {sessionId:options.sessionId, candidateToken:token, key, keySource:options.keySource,
          configurationId:options.configurationId, credentialRevision:options.expectedCredentialRevision,
          mainCredentialRevision:options.expectedMainCredentialRevision,
          config:{region:options.region,workspace:options.workspace,model:options.model}};
        const result = {sessionId:options.sessionId,connected:true,candidateToken:token};
        // Deliberately permit a late acknowledgment after cancellation to test frontend isolation.
        if (window.__holdTest) return new Promise(resolve => {window.__finishTest=()=>resolve(result)});
        return result;
      }
      if (method === 'commitTestedKey') {
        try {
          if (window.__holdCommit) await new Promise(resolve => {window.__finishCommit=resolve});
          checkRevision(options);
          if (!candidate || candidate.sessionId !== options.sessionId || candidate.candidateToken !== options.candidateToken
            || candidate.configurationId !== options.configurationId || candidate.credentialRevision !== options.expectedCredentialRevision
            || candidate.mainCredentialRevision !== options.expectedMainCredentialRevision) throw {code:'SPEECH_SESSION_INVALID'};
          if (window.__commitError) throw {code:window.__commitError};
          savedKey=candidate.key; source=candidate.keySource; activeConfig={...candidate.config};
          committedMainRevision=candidate.mainCredentialRevision; candidate=undefined;
          window.__voiceHasKey=true; window.__voiceRevision++; window.__voiceCommitCount++;
          window.__voiceCommitOutcomes.push({sessionId:options.sessionId,committed:true});
          return configuration();
        } catch (error) {
          window.__voiceCommitOutcomes.push({sessionId:options.sessionId,committed:false,code:error.code});
          throw error;
        }
      }
      if (method === 'start') {
        if (window.__voiceError) throw {code:window.__voiceError,message:'PRIVATE_PROVIDER_ECHO'};
        if (options.expectedCredentialRevision !== String(window.__voiceRevision)) throw {code:'SPEECH_KEY_CHANGED'};
        if (!effectiveKey()) throw {code:'SPEECH_KEY_REQUIRED'};
        if (activeConfig && ['region','workspace','model'].some(key=>activeConfig[key]!==options[key])) throw {code:'SPEECH_CONFIG_INVALID'};
        window.__voiceListeners.forEach(callback => callback({sessionId:options.sessionId,state:'listening'}));
        return new Promise((resolve,reject) => window.__voicePending.set(options.sessionId,{resolve,reject}));
      }
      if (method === 'stop') {
        window.__voicePending.get(options.sessionId)?.resolve({sessionId:options.sessionId,text:window.__voiceText});
        return {};
      }
      if (method === 'cancel' && candidate?.sessionId === options.sessionId) candidate=undefined;
      // Deliberately let cancelled recorder replies arrive later to exercise stale isolation.
      return {};
    },
  };
})()'''.replace('__MOCK_APP_VERSION__', json.dumps(json.loads((Path(__file__).parents[1] / 'package.json').read_text())['version']))


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


def image(page, name, width, motion):
    page.locator('#toast.show').wait_for(state='hidden'); page.wait_for_timeout(150)
    assert_usable(page, '.short-voice-panel')
    page.screenshot(path=str(OUT / f'{name}-{width}-{motion}.png'), animations='disabled')


def run(page, width, motion):
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
    page.locator('[data-page="page-mine"]').click(); page.get_by_role('button', name='应用设置', exact=True).click()
    key = page.locator('#voice-bailian-key')
    key.wait_for(); key.scroll_into_view_if_needed()
    expect(key).to_be_enabled(); expect(key).to_have_value('')
    expect(key).to_have_accessible_name('语音Key')
    expect(page.locator('#voice-key-shared')).not_to_be_checked()
    expect(page.locator('[data-voice-save-key], [data-voice-clear-key], [data-voice-key-status]')).to_have_count(0)
    key.fill('synthetic-voice-test-key'); key.press('Tab')
    page.locator('#voice-bailian-workspace').fill('tested-workspace')
    page.locator('#voice-bailian-workspace').press('Tab')
    assert page.evaluate('window.__voiceCommitCount') == 0
    assert not any(row['method'] == 'testCandidate' for row in page.evaluate('window.__voiceCalls'))
    assert next(row['value'] for row in read_rows(page,'settings') if row['key']=='voice.bailian.workspace') == 'synthetic-workspace'
    test_button = page.locator('[data-voice-test]')
    expect(test_button).to_have_text('测试语音连接')
    expect(page.locator('[data-voice-test-consent], [data-voice-test-confirm], [data-voice-test-cancel], [data-voice-test-status], [data-voice-test-copy], [data-voice-test-copy-status]')).to_have_count(0)
    test_button.click()
    expect(test_button).to_have_attribute('data-state', 'success')
    expect(test_button).to_have_text('测试语音连接')
    expect(page.locator('#toast.show')).to_contain_text('连接通过')
    expect(page.locator('#toast.show')).to_contain_text('录音未测试')
    candidate = page.evaluate("window.__voiceCalls.filter(x=>x.method==='testCandidate')")
    assert len(candidate) == 1 and candidate[0]['consent'] and candidate[0]['userInitiated']
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').length") == 0
    expect(key).to_have_value('')
    expect(key).to_have_attribute('placeholder', 'synth••••••t-key')
    assert page.evaluate('window.__voiceCommitCount') == 1
    assert page.evaluate('window.__voiceSnapshot().activeConfig') == {'region': 'beijing', 'workspace': 'tested-workspace', 'model': 'qwen3.8-omni-flash-realtime'}
    assert not requests
    assert not any('synthetic-voice-test-key' in str(row) for row in read_rows(page,'settings'))
    assert page.evaluate("!JSON.stringify({...localStorage,...sessionStorage}).includes('synthetic-voice-test-key')")
    assert 'synthetic-voice-test-key' not in page.locator('#sp-settings').inner_html()
    assert_usable(page, '#sp-settings section[aria-label="百炼短语音"]')
    page.screenshot(path=str(OUT / f'settings-{width}-{motion}.png'), animations='disabled')
    page.locator('#sp-settings [data-act="back"]').click()
    page.locator('[data-page="page-home"]').click()

    # Opening never captures/sends; dismiss keeps every underlying draft field.
    page.locator('#fab').click(); page.locator('#note').fill('原本的虚构草稿')
    page.locator('#note').blur()
    page.locator('#keypad [data-k="9"]').click(); page.locator('#btn-voice').click()
    expect(page.locator('[data-sv-start]')).to_be_enabled()
    expect(page.locator('[data-sv-start]')).to_have_accessible_name('开始说话，使用阿里云百炼')
    expect(page.locator('[data-sv-consent]')).to_have_count(0)
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').length") == 0
    image(page, 'consent', width, motion)
    page.locator('[data-sv-close]').click(); expect(page.locator('#note')).to_have_value('原本的虚构草稿')
    expect(page.locator('#amt')).to_have_text('9'); page.locator('#sheet-close').click()

    open_entry_voice(page)
    page.locator('[data-sv-start]').click(); expect(page.locator('[data-sv-status]')).to_contain_text('正在听')
    page.locator('[data-sv-start]').dispatch_event('click')
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').length") == 1
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').at(-1).workspace") == 'tested-workspace'
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').at(-1).model") == 'qwen3.8-omni-flash-realtime'
    image(page, 'listening', width, motion)
    page.locator('[data-sv-stop]').click(); expect(page.locator('[data-sv-text]')).to_have_value('今天午餐28.01元，现金')
    assert not payloads
    page.locator('[data-sv-text]').fill('核对后午餐28.01元，现金')
    expect(page.locator('[data-sv-send-panel]')).to_be_visible()
    assert not payloads; image(page, 'text-consent', width, motion)
    page.locator('[data-sv-text]').fill('最终核对午餐28.01元，现金')
    expect(page.locator('[data-sv-send-panel]')).to_be_hidden()
    page.locator('[data-sv-send]').click()
    expect(page.locator('[data-sv-result]')).to_be_visible(); image(page, 'draft', width, motion)
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
    page.locator('[data-sv-rerecord]').click()
    page.locator('[data-sv-start]').click(); expect(page.locator('[data-sv-status]')).to_contain_text('麦克风未获授权')
    assert 'PRIVATE_PROVIDER_ECHO' not in page.locator('.short-voice-panel').inner_text()
    image(page,'permission-error',width,motion)
    page.locator('[data-sv-close]').click(); page.locator('#sheet-close').click()
    page.evaluate('window.__voiceError=null')

    # High-confidence voice draft remains ready until an explicit inbox confirmation.
    page.locator('[data-qa="ai"]').click()
    page.locator('#ai-text').fill('原本尚未发送的收件箱虚构草稿')
    page.locator('[data-act="short-voice"]').click()
    page.locator('[data-sv-text]').fill('虚构午餐28.01元现金')
    page.locator('[data-sv-send]').click()
    expect(page.locator('[data-sv-result]')).to_be_visible(); page.locator('[data-sv-apply]').click()
    expect(page.locator('.short-voice-mask')).to_have_count(0)
    expect(page.locator('#ai-text')).to_have_value('原本尚未发送的收件箱虚构草稿')
    queue=next(row['value'] for row in read_rows(page,'settings') if row['key']=='ai.pendingItems')
    assert len(queue)==1 and queue[0]['source']=='voice' and queue[0]['status']=='ready'
    assert len(read_rows(page,'entries'))==1
    page.locator('.ai-card [data-act="ignore"]').click()
    assert page.evaluate('window.__micCalls')==0
    assert all(url.startswith('https://short-voice.invalid/') for url in requests), requests
    assert not errors,errors


def web_mode(page,width,motion):
    page.goto(URL);page.locator('#fab').wait_for()
    page.locator('#fab').click();page.locator('#btn-voice').click()
    expect(page.locator('[data-sv-status]')).to_contain_text('仅支持 Android')
    expect(page.locator('[data-sv-start]')).to_be_disabled()
    image(page,'web-fallback',width,motion)
    page.locator('[data-sv-close]').click();page.locator('#sheet-close').click()
    page.locator('[data-page="page-mine"]').click();page.get_by_role('button', name='应用设置', exact=True).click()
    expect(page.locator('#voice-bailian-key')).to_be_disabled()
    expect(page.locator('#voice-key-shared')).to_be_disabled()
    expect(page.locator('[data-voice-test]')).to_be_disabled()
    expect(page.locator('[aria-label="百炼短语音"]')).to_contain_text('仅 Android 可用')
    expect(page.locator('[data-voice-save-key], [data-voice-clear-key], [data-voice-key-status]')).to_have_count(0)


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width in (360,390,430,1280):
            for motion in ('reduce', 'no-preference'):
                context=browser.new_context(viewport={'width':width,'height':844},service_workers='block',reduced_motion=motion)
                page = context.new_page()
                try:
                    run(page,width,motion)
                except Exception:
                    try:
                        page.screenshot(path=str(OUT / f'failure-native-{width}-{motion}.png'), animations='disabled')
                    except Exception:
                        print('Unable to capture the native short voice failure screen', flush=True)
                    raise
                finally:
                    context.close()
                web=browser.new_context(viewport={'width':width,'height':844},service_workers='block',reduced_motion=motion)
                page = web.new_page()
                try:
                    web_mode(page,width,motion)
                except Exception:
                    try:
                        page.screenshot(path=str(OUT / f'failure-web-{width}-{motion}.png'), animations='disabled')
                    except Exception:
                        print('Unable to capture the web short voice failure screen', flush=True)
                    raise
                finally:
                    web.close()
            print(f'PASS synthetic short voice {width}',flush=True)
        browser.close()
