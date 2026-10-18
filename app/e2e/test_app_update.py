"""Offline Android update button / progress / reopen workflow; no GitHub or installer calls."""
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/app-update'
MOCK = MOCK_NATIVE + r'''
window.__updateCalls=[]; window.__updateListeners=new Map(); window.__updateListenerId=0;
window.__updateHasToken=localStorage.getItem('synthetic-update-token')==='saved';
window.__updateCache=JSON.parse(localStorage.getItem('synthetic-update-cache')||'null');
window.__updateAvailable=true; window.__updateError=''; window.__updateHold=false;
window.__updatePermission=true; window.__pendingUpdate=null;
const release={available:true,releaseId:'17',version:'1.12.0',size:5689871,
 notes:'修复备份与恢复\n<img src=x onerror=alert(1)>\n'+'更新说明。'.repeat(60)};
const saveCache=value=>{window.__updateCache=value;
 if(value)localStorage.setItem('synthetic-update-cache',JSON.stringify(value));
 else localStorage.removeItem('synthetic-update-cache');};
window.__emitUpdateProgress=(received,total,extra={})=>{
 const pending=window.__pendingUpdate;
 const event={requestId:pending?.requestId,releaseId:'17',received,total,...extra};
 window.__updateListeners.forEach(callback=>callback(event));
};
window.Capacitor.PluginHeaders.push({name:'GleamUpdate',methods:[
 ...['configuration','restore','readClipboard','saveToken','clearToken','check','download','install','cancel'].map(name=>({name,rtype:'promise'})),
 ...['addListener','removeListener'].map(name=>({name,rtype:'callback'}))]});
const originalUpdateCallback=window.Capacitor.nativeCallback;
window.Capacitor.nativeCallback=function(plugin,method,options,callback){
 if(plugin!=='GleamUpdate')return originalUpdateCallback.call(this,plugin,method,options,callback);
 if(method==='addListener'){const id='update-'+(++window.__updateListenerId);window.__updateListeners.set(id,callback);return id;}
 if(method==='removeListener')window.__updateListeners.delete(options.callbackId);
};
const originalUpdatePromise=window.Capacitor.nativePromise;
window.Capacitor.nativePromise=async function(plugin,method,options={}){
 if(plugin!=='GleamUpdate')return originalUpdatePromise.call(this,plugin,method,options);
 window.__updateCalls.push({method,requestId:options.requestId});
 if(method==='configuration'){
  if(window.__updateConfigurationError)throw {code:'STORAGE'};
  return {hasToken:window.__updateHasToken};
 }
 if(method==='restore'){
  const pending=window.__pendingUpdate;
  if(pending){pending.cancelled=true;pending.reject({code:'CANCELLED'});window.__pendingUpdate=null;}
  if(window.__cacheInvalid)saveCache(null);
  return window.__updateCache ? {...window.__updateCache,downloaded:true} : {available:false,downloaded:false};
 }
 if(method==='readClipboard'){
  if(window.__clipboardError)throw {code:window.__clipboardError};
  return {text:' synthetic_token_for_offline_tests '};
 }
 if(method==='cancel'){
  const pending=window.__pendingUpdate;
  if(pending?.requestId===options.requestId){pending.cancelled=true;pending.reject({code:'CANCELLED'});window.__pendingUpdate=null;}
  return {};
 }
 if(method==='install'){
  if(window.__updateInstallError){saveCache(null);throw {code:window.__updateInstallError};}
  return {permissionRequired:window.__updatePermission};
 }
 if(window.__updateError)throw {code:window.__updateError,message:'PRIVATE_TOKEN_RESPONSE'};
 if(method==='saveToken'){window.__updateHasToken=true;localStorage.setItem('synthetic-update-token','saved');saveCache(null);return {};}
 if(method==='clearToken'){window.__updateHasToken=false;localStorage.removeItem('synthetic-update-token');saveCache(null);return {};}
 if(method==='check')saveCache(null);
 if(method==='check'||method==='download'){
  const value=method==='check'?{...release,available:window.__updateAvailable}:{};
  if(window.__updateHold)return new Promise((resolve,reject)=>{
   const pending={...options,method,reject,cancelled:false};window.__pendingUpdate=pending;
   window.__finishUpdate=()=>{if(pending.cancelled)return;
    if(method==='download')saveCache(release);
    if(window.__pendingUpdate===pending)window.__pendingUpdate=null;resolve(value);};
  });
  if(method==='download')saveCache(release);
  return value;
 }
 return {};
};
'''


def open_about(page):
    page.locator('[data-page="page-mine"]').click()
    page.locator('#page-mine [data-about]').click()
    page.locator('#sheet.open [data-update-action]').wait_for()
    return page.locator('#sheet')


def run(page, width, theme='light', scale=1):
    page.set_default_timeout(10000)
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('**/*', lambda route: route.continue_() if urlsplit(route.request.url).netloc == urlsplit(URL).netloc
        else (external.append(route.request.url), route.abort()))
    page.add_init_script(MOCK)
    page.goto(URL)
    page.locator('#fab').wait_for()
    page.evaluate('s=>document.documentElement.style.setProperty("--seed-type",String(s))', scale)
    sheet = open_about(page)
    action = sheet.locator('[data-update-action]')
    status = sheet.locator('[data-update-status]')
    expect(action).to_have_count(1)
    expect(action).to_have_text('检查更新')
    expect(status).to_contain_text('请先配置')
    expect(action).to_be_disabled()
    assert page.evaluate('window.__updateCalls.map(c=>c.method)') == ['configuration','restore']
    token = sheet.locator('#update-token')
    expect(token).to_have_attribute('readonly','')
    token.focus(); token.press_sequentially('cannot_type_this')
    expect(token).to_have_value('')
    page.evaluate("window.__clipboardError='CLIPBOARD_EMPTY'")
    sheet.locator('[data-update-paste]').click()
    expect(status).to_contain_text('剪贴板中没有文本')
    page.evaluate("window.__clipboardError=''")
    sheet.locator('[data-update-paste]').click()
    expect(token).to_have_value('synthetic_token_for_offline_tests')
    expect(token).to_have_attribute('type','password')
    sheet.locator('[data-update-save]').click()
    expect(status).to_contain_text('Token 已保存')
    expect(token).to_have_value('')
    page.evaluate('window.__originalUpdateButton=document.querySelector("[data-update-action]")')
    page.evaluate('window.__updateHold=true')
    action.click()
    expect(action).to_have_text('检查中…')
    page.wait_for_function('window.__pendingUpdate?.method==="check"')
    check_count=page.evaluate('window.__updateCalls.filter(c=>c.method==="check").length')
    action.dispatch_event('click')
    assert page.evaluate('window.__updateCalls.filter(c=>c.method==="check").length')==check_count
    page.evaluate('window.__finishUpdate();window.__updateHold=false')
    expect(action).to_have_text('下载更新')
    assert action.evaluate('el=>el===window.__originalUpdateButton')
    expect(sheet.locator('[data-update-version]')).to_have_text('发现新版 v1.12.0')
    expect(sheet.locator('[data-update-notes] img')).to_have_count(0)
    assert_usable(page, '#sheet')

    # A progress event changes the button fill, never creates a second main button.
    page.evaluate('window.__updateHold=true')
    action.click()
    expect(action).to_contain_text('0%')
    page.wait_for_function('window.__pendingUpdate?.method==="download"')
    page.evaluate('window.__emitUpdateProgress(25,100)')
    expect(action).to_contain_text('25%')
    page.evaluate('window.__emitUpdateProgress(60,100)')
    expect(action).to_contain_text('60%')
    page.evaluate('window.__emitUpdateProgress(95,100,{requestId:"old-request"});window.__emitUpdateProgress(20,100)')
    expect(action).to_contain_text('60%')
    expect(action).to_be_disabled()
    expect(sheet.locator('[data-update-progress]')).to_have_attribute('aria-valuenow','60')
    action.scroll_into_view_if_needed()
    page.wait_for_timeout(250)
    ratio=action.evaluate('el=>parseFloat(getComputedStyle(el,"::before").width)/el.getBoundingClientRect().width')
    assert abs(ratio-.6)<.03, ratio
    assert page.evaluate('document.documentElement.dataset.theme==="dark"') == (theme=='dark')
    page.screenshot(path=str(OUT/f'progress-{width}-{theme}-{scale}.png'), animations='disabled')
    download_id=page.evaluate('window.__pendingUpdate.requestId')
    page.evaluate('()=>{window.__oldUpdateCallback=[...window.__updateListeners.values()][0]}')
    sheet.locator('[data-update-close]').click()
    page.wait_for_function('window.__updateListeners.size===0')
    assert not page.evaluate('id=>window.__updateCalls.some(c=>c.method==="cancel"&&c.requestId===id)',download_id)
    page.evaluate('window.__finishUpdate()')  # Completes while About is closed.
    remote_checks=page.evaluate('window.__updateCalls.filter(c=>c.method==="check").length')
    open_about(page)
    expect(action).to_have_text('更新')
    assert page.evaluate('window.__updateCalls.filter(c=>c.method==="check").length')==remote_checks
    action.click()
    expect(status).to_contain_text('允许拾光安装应用')
    expect(action).to_have_text('更新')
    page.evaluate('window.__updatePermission=false')
    action.click()
    expect(status).to_contain_text('已打开系统安装界面')

    # A new WebView session restores a validated ready package without network access.
    page.reload()
    page.locator('#fab').wait_for()
    page.evaluate('s=>document.documentElement.style.setProperty("--seed-type",String(s))', scale)
    page.evaluate("window.__updateError='NETWORK';window.__updateConfigurationError=true;window.__updatePermission=false")
    open_about(page)
    expect(action).to_have_text('更新')
    assert not page.evaluate('window.__updateCalls.some(c=>c.method==="check")')
    action.click()  # Installation itself remains offline and needs no readable token.
    expect(status).to_contain_text('已打开系统安装界面')
    page.screenshot(path=str(OUT/f'restored-{width}-{theme}-{scale}.png'), animations='disabled')
    page.evaluate("window.__updateInstallError='RECHECK'")
    action.click()
    expect(status).to_contain_text('安装包已失效')
    expect(action).to_have_text('检查更新')
    sheet.locator('[data-update-close]').click()
    page.evaluate("window.__updateError='';window.__updateInstallError='';window.__updateConfigurationError=false;window.__cacheInvalid=true")
    open_about(page)
    expect(action).to_have_text('检查更新')
    page.evaluate('window.__cacheInvalid=false')
    action.click()
    expect(action).to_have_text('下载更新')
    page.evaluate('window.__updateHold=true')
    action.click()
    page.wait_for_function('window.__pendingUpdate?.method==="download"')
    page.evaluate('()=>{window.__emitUpdateProgress(44,100);window.__oldFinishUpdate=window.__finishUpdate;window.__oldUpdateCallback=[...window.__updateListeners.values()][0]}')
    sheet.locator('[data-update-close]').click()
    open_about(page)  # Incomplete package: restore cancels/discards it and resets to Check.
    expect(action).to_have_text('检查更新')
    page.evaluate('window.__oldFinishUpdate();window.__oldUpdateCallback({requestId:"old-request",releaseId:"17",received:100,total:100})')
    expect(action).to_have_text('检查更新')
    expect(sheet.locator('[data-update-release]')).to_be_hidden()

    page.evaluate('window.__updateHold=false')
    action.click()
    expect(action).to_have_text('下载更新')
    page.evaluate("window.__updateError='CHECKSUM'")
    action.click()
    expect(status).to_contain_text('校验失败')
    expect(action).to_have_text('下载更新')
    page.evaluate("window.__updateError='';window.__updateHold=true")
    action.click()
    page.wait_for_function('window.__pendingUpdate?.method==="download"')
    sheet.locator('[data-update-cancel]').click()
    expect(status).to_contain_text('已取消')
    expect(action).to_have_text('下载更新')
    page.evaluate("window.__updateHold=false;window.__updateError='AUTH'")
    sheet.locator('[data-update-recheck]').click()
    expect(status).to_contain_text('Token 已失效')
    expect(sheet).not_to_contain_text('PRIVATE_TOKEN_RESPONSE')
    expect(action).to_have_text('检查更新')
    page.evaluate("window.__updateError='';window.__updateAvailable=false")
    action.click()
    expect(status).to_contain_text('当前已是最新版本')
    expect(action).to_have_text('检查更新')
    page.evaluate('window.__updateAvailable=true;window.__updateHold=true')
    action.click()
    page.wait_for_function('window.__pendingUpdate?.method==="check"')
    check_id=page.evaluate('window.__pendingUpdate.requestId')
    page.evaluate('()=>{window.__oldCheckFinish=window.__finishUpdate}')
    sheet.locator('[data-update-close]').click()
    assert page.evaluate('id=>window.__updateCalls.some(c=>c.method==="cancel"&&c.requestId===id)',check_id)
    open_about(page)
    expect(action).to_have_text('检查更新')
    page.evaluate('window.__oldCheckFinish();window.__updateHold=false')
    expect(action).to_have_text('检查更新')
    sheet.locator('[data-update-config] summary').click()
    sheet.locator('[data-update-clear]').click()
    expect(status).to_contain_text('Token 已移除')
    expect(action).to_be_disabled()
    assert not errors, errors
    assert not external, external
    assert page.evaluate('window.__micCalls')==0


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width,theme,scale in [(360,'light',1),(390,'dark',1),(400,'light',1.3),(400,'dark',1.3),(430,'light',1),(1280,'light',1)]:
            context=browser.new_context(viewport={'width':width,'height':844},service_workers='block',
                color_scheme=theme,reduced_motion='reduce',device_scale_factor=3 if width==400 else 1)
            run(context.new_page(),width,theme,scale)
            context.close()
            print('PASS Android update button / progress / restore',width,theme,scale,flush=True)
        context=browser.new_context(service_workers='block')
        page=context.new_page();page.goto(URL);page.locator('#fab').wait_for()
        page.locator('[data-page="page-mine"]').click();page.locator('#page-mine [data-about]').click()
        expect(page.locator('#sheet [data-update-action]')).to_have_count(0)
        context.close();browser.close()
