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
      {name:'GleamEntry',methods:methods(['setShortcuts','updateWidget','keyFeedback'])},
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
      if (plugin === 'GleamEntry' && method === 'keyFeedback') { window.__haptics=(window.__haptics||0)+1; return {}; }
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


def open_voice_advanced(page):
    details = page.locator('[data-settings-detail="voice-advanced"]')
    if not details.evaluate('el=>el.open'):
        details.locator(':scope > summary').click()


def seed_config(page):
    page.evaluate('''async () => {
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('settings','readwrite');
      for(const [key,value] of [['ai.baseUrl','https://short-voice.invalid/v1'],['ai.model','mock-text-model'],['ai.autoConfirmThreshold',50],['voice.bailian.workspace','synthetic-workspace']]) tx.objectStore('settings').put({key,value,updatedAt:1});
      await new Promise(resolve=>tx.oncomplete=resolve);db.close();
    }''')


def open_inbox_voice(page):
    if not page.locator('#sp-ai-inbox.open').count():
        page.locator('[data-qa="ai"]').click()
    page.locator('[data-act="short-voice"]').click(); page.locator('[data-hv-hold]').wait_for()


def image(page, name, width, motion):
    page.locator('#toast.show').wait_for(state='hidden'); page.wait_for_timeout(150)
    assert_usable(page, '.hold-voice-stage' if page.locator('.hold-voice-mask').count() else '#sheet .sheet-head')
    page.screenshot(path=str(OUT / f'{name}-{width}-{motion}.png'), animations='disabled')


def run(page, width, motion):
    shared_service = width == 400
    expected_workspace = '' if shared_service else 'tested-workspace'
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
    if shared_service:
        page.evaluate('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const tx=db.transaction('settings','readwrite');tx.objectStore('settings').delete('voice.bailian.workspace');await new Promise(r=>tx.oncomplete=r);db.close();}''')
        page.evaluate('motion=>{document.documentElement.dataset.theme=motion==="reduce"?"dark":"light";document.documentElement.style.setProperty("--seed-type",motion==="reduce"?"1.2":"1");document.documentElement.style.setProperty("--safe-top","24px");document.documentElement.style.setProperty("--safe-bottom","24px");}', motion)
    page.locator('[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-ai-settings"]').click()
    key = page.locator('#voice-bailian-key')
    key.wait_for(); key.scroll_into_view_if_needed()
    expect(key).to_be_enabled(); expect(key).to_have_value('')
    expect(key).to_have_accessible_name('语音Key')
    expect(page.locator('#voice-key-shared')).not_to_be_checked()
    expect(page.locator('[data-voice-save-key], [data-voice-clear-key], [data-voice-key-status]')).to_have_count(0)
    key.fill('synthetic-voice-test-key'); key.press('Tab')
    expect(page.locator('[data-settings-detail="voice-advanced"]')).not_to_have_attribute('open', '')
    if not shared_service:
        open_voice_advanced(page)
        page.locator('#voice-bailian-workspace').fill(expected_workspace)
        page.locator('#voice-bailian-workspace').press('Tab')
    assert page.evaluate('window.__voiceCommitCount') == 0
    assert not any(row['method'] == 'testCandidate' for row in page.evaluate('window.__voiceCalls'))
    assert next((row['value'] for row in read_rows(page,'settings') if row['key']=='voice.bailian.workspace'), '') == ('' if shared_service else 'synthetic-workspace')
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
    assert page.evaluate('window.__voiceSnapshot().activeConfig') == {'region': 'beijing', 'workspace': expected_workspace, 'model': 'qwen3.8-omni-flash-realtime'}
    assert not requests
    assert not any('synthetic-voice-test-key' in str(row) for row in read_rows(page,'settings'))
    assert page.evaluate("!JSON.stringify({...localStorage,...sessionStorage}).includes('synthetic-voice-test-key')")
    assert 'synthetic-voice-test-key' not in page.locator('#sp-ai-settings').inner_html()
    assert_usable(page, '#sp-ai-settings section[aria-label="百炼短语音"]')
    page.screenshot(path=str(OUT / f'settings-{width}-{motion}.png'), animations='disabled')
    page.locator('#sp-ai-settings [data-act="back"]').click()
    page.locator('[data-page="page-home"]').click()

    # Click only opens the shared idle surface. Holding is the recording consent.
    from test_hold_voice import center, preview, release_at
    page.locator('[data-qa="ai"]').click(); page.locator('#ai-text').fill('原本的虚构草稿')
    open_inbox_voice(page); expect(page.locator('[data-hv-cue]')).to_have_text('按住说话')
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').length") == 0
    image(page, 'ready', width, motion)
    page.locator('[data-hv-zone="cancel"]').click(); expect(page.locator('#ai-text')).to_have_value('原本的虚构草稿')
    open_inbox_voice(page)
    page.mouse.move(*center(page.locator('[data-hv-hold]'))); page.mouse.down()
    expect(page.locator('.hold-voice-mask')).to_have_attribute('data-state','listening')
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').length") == 1
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').at(-1).workspace") == expected_workspace
    assert page.evaluate("window.__voiceCalls.filter(x=>x.method==='start').at(-1).model") == 'qwen3.8-omni-flash-realtime'
    preview(page,'今天午餐28.01元，现金'); image(page,'listening',width,motion)
    release_at(page,'edit'); expect(page.locator('[data-hv-text]')).to_have_value('今天午餐28.01元，现金')
    assert not payloads
    page.locator('[data-hv-text]').fill('最终核对午餐28.01元，现金'); image(page,'text-review',width,motion)
    page.locator('[data-hv-send]').click(); page.locator('#sheet.open').wait_for()
    assert payloads[-1]['messages'][1]['content'] == '最终核对午餐28.01元，现金'
    assert not read_rows(page,'entries')
    assert not next((r['value'] for r in read_rows(page,'settings') if r['key']=='ai.pendingItems'),[])
    expect(page.locator('#amt')).to_contain_text('28.01'); image(page,'draft',width,motion)
    page.locator('#keypad [data-k="save"]').click();page.locator('#sheet.open').wait_for(state='hidden')
    rows=read_rows(page,'entries');assert len(rows)==1 and rows[0]['amount']==2801
    expect(page.locator('#ai-text')).to_have_value('原本的虚构草稿')
    # Permission errors stay editable and never expose the provider's private body.
    open_inbox_voice(page);page.evaluate("window.__voiceError='SPEECH_PERMISSION_DENIED'")
    page.mouse.move(*center(page.locator('[data-hv-hold]')));page.mouse.down()
    expect(page.locator('[data-hv-message]')).to_contain_text('麦克风权限');page.mouse.up()
    assert 'PRIVATE_PROVIDER_ECHO' not in page.locator('.hold-voice-mask').inner_text()
    image(page,'permission-error',width,motion);page.locator('[data-hv-close]').click()
    assert page.evaluate('window.__micCalls')==0
    assert all(url.startswith('https://short-voice.invalid/') for url in requests),requests
    assert not errors,errors


def web_mode(page,width,motion):
    page.goto(URL);page.locator('#fab').wait_for()
    open_inbox_voice(page)
    from test_hold_voice import center
    page.mouse.move(*center(page.locator('[data-hv-hold]')));page.mouse.down()
    expect(page.locator('[data-hv-message]')).to_contain_text('仅支持 Android');page.mouse.up()
    expect(page.locator('[data-hv-text]')).to_be_enabled()
    image(page,'web-fallback',width,motion)
    page.locator('[data-hv-close]').click();page.locator('#sp-ai-inbox [data-act="back"]').click()
    page.locator('[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-ai-settings"]').click()
    expect(page.locator('#voice-bailian-key')).to_be_disabled()
    expect(page.locator('#voice-key-shared')).to_be_disabled()
    expect(page.locator('[data-voice-test]')).to_be_disabled()
    expect(page.locator('[aria-label="百炼短语音"]')).to_contain_text('仅 Android 可用')
    expect(page.locator('[data-voice-save-key], [data-voice-clear-key], [data-voice-key-status]')).to_have_count(0)


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width in (360,390,400,430,1280):
            for motion in ('reduce', 'no-preference'):
                context=browser.new_context(viewport={'width':width,'height':890 if width==400 else 844},device_scale_factor=3 if width==400 else 1,service_workers='block',reduced_motion=motion)
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
