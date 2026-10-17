"""Offline Android bridge update workflow and four-width UI; no GitHub calls or installs."""
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/app-update'
MOCK = MOCK_NATIVE + r'''
window.__updateCalls=[]; window.__updateHasToken=false; window.__updateAvailable=true;
window.__updateError=''; window.__updateHold=false; window.__updatePermission=true;
window.Capacitor.PluginHeaders.push({name:'GleamUpdate',methods:['configuration','readClipboard','saveToken','clearToken','check','download','install','cancel'].map(name=>({name,rtype:'promise'}))});
const originalUpdatePromise=window.Capacitor.nativePromise;
window.Capacitor.nativePromise=async function(plugin,method,options={}) {
  if(plugin!=='GleamUpdate') return originalUpdatePromise.call(this,plugin,method,options);
  window.__updateCalls.push({method,requestId:options.requestId});
  if(method==='configuration') return {hasToken:window.__updateHasToken};
  if(method==='readClipboard') { if(window.__clipboardError) throw {code:window.__clipboardError}; return {text:'  synthetic_token_for_offline_tests  '}; }
  if(method==='cancel') { if(window.__rejectUpdate) window.__rejectUpdate({code:'CANCELLED'}); return {}; }
  if(window.__updateError) throw {code:window.__updateError,message:'PRIVATE_TOKEN_RESPONSE'};
  if(method==='saveToken') {window.__updateHasToken=true; return {};}
  if(method==='clearToken') {window.__updateHasToken=false; return {};}
  if(method==='check') {
    const value={available:window.__updateAvailable,releaseId:'17',version:'1.12.0',size:5689871,notes:'修复备份与恢复\n<img src=x onerror=alert(1)>\n'+ '更新说明。'.repeat(60)};
    if(window.__updateHold) return new Promise((resolve,reject)=>{window.__finishUpdate=()=>resolve(value);window.__rejectUpdate=reject;});
    return value;
  }
  if(method==='download' && window.__updateHold) return new Promise((resolve,reject)=>{window.__finishUpdate=resolve;window.__rejectUpdate=reject;});
  if(method==='install') return {permissionRequired:window.__updatePermission};
  return {};
};
'''

def run(page, width):
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def local_only(route):
        if urlsplit(route.request.url).netloc != urlsplit(URL).netloc:
            external.append(route.request.url); route.abort()
        else: route.continue_()
    page.route('**/*', local_only)
    page.add_init_script(MOCK)
    page.goto(URL); page.locator('#fab').wait_for()
    page.locator('[data-page="page-mine"]').click()
    page.locator('[data-about]').click()
    sheet = page.locator('#sheet')
    check = sheet.locator('[data-update-check]')
    status = sheet.locator('[data-update-status]')
    expect(status).to_contain_text('请先配置')
    expect(check).to_be_disabled()
    assert page.evaluate('window.__updateCalls.map(c=>c.method)') == ['configuration']
    assert sheet.locator('[data-update-paste]').count()==1
    page.evaluate("window.__clipboardError='CLIPBOARD_EMPTY'")
    sheet.locator('[data-update-paste]').click(); expect(status).to_contain_text('剪贴板中没有文本')
    expect(sheet.locator('[data-update-save]')).to_be_disabled()
    page.evaluate("window.__clipboardError=''")
    sheet.locator('[data-update-paste]').click()
    expect(sheet.locator('#update-token')).to_have_value('synthetic_token_for_offline_tests')
    expect(sheet.locator('#update-token')).to_have_attribute('type','password')
    assert not any(c['method']=='saveToken' for c in page.evaluate('window.__updateCalls'))
    sheet.locator('[data-update-save]').click()
    expect(status).to_contain_text('Token 已保存')
    expect(sheet.locator('#update-token')).to_have_value('')
    check.click(); expect(status).to_contain_text('下载后校验')
    expect(sheet.locator('[data-update-version]')).to_have_text('发现新版 v1.12.0')
    expect(sheet.locator('[data-update-notes] img')).to_have_count(0)
    assert_usable(page, '#sheet')
    page.screenshot(path=str(OUT/f'available-{width}.png'), animations='disabled')
    page.evaluate("window.__updateError='CHECKSUM'")
    sheet.locator('[data-update-download]').click(); expect(status).to_contain_text('校验失败')
    expect(sheet.locator('[data-update-install]')).to_be_hidden()
    page.evaluate("window.__updateError=''; window.__updateHold=true")
    sheet.locator('[data-update-download]').click(); expect(check).to_be_disabled()
    sheet.locator('[data-update-cancel]').click(); expect(status).to_contain_text('已取消')
    page.evaluate('window.__updateHold=false')
    sheet.locator('[data-update-download]').click(); expect(status).to_contain_text('校验通过')
    sheet.locator('[data-update-install]').click(); expect(status).to_contain_text('允许拾光安装应用')
    page.evaluate('window.__updatePermission=false')
    sheet.locator('[data-update-install]').click(); expect(status).to_contain_text('已打开系统安装界面')
    page.evaluate("window.__updateError='AUTH'")
    check.click(); expect(status).to_contain_text('Token 已失效')
    expect(sheet).not_to_contain_text('PRIVATE_TOKEN_RESPONSE')
    expect(sheet.locator('[data-update-install]')).to_be_hidden()
    page.evaluate("window.__updateError=''; window.__updateAvailable=false")
    check.click(); expect(status).to_contain_text('当前已是最新版本')
    page.evaluate('window.__updateHold=true')
    check.click()
    sheet.locator('[data-update-close]').click()
    page.locator('[data-about]').click()
    expect(status).to_contain_text('点击检查')
    page.evaluate('window.__finishUpdate()')
    expect(status).to_contain_text('点击检查')
    sheet.locator('[data-update-config] summary').click()
    sheet.locator('[data-update-clear]').click(); expect(status).to_contain_text('Token 已移除')
    expect(check).to_be_disabled()
    page.evaluate("document.documentElement.style.fontSize='130%'")
    assert_usable(page, '#sheet')
    page.screenshot(path=str(OUT/f'configuration-large-{width}.png'), animations='disabled')
    sheet.locator('[data-update-close]').click()
    page.get_by_role('button', name='应用设置', exact=True).click()
    page.locator('[data-act="app-update"]').click()
    expect(sheet).to_have_attribute('aria-label', '关于拾光')
    assert not errors, errors
    assert not external, external
    assert page.evaluate('window.__micCalls') == 0

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width in (360,390,430,1280):
            context=browser.new_context(viewport={'width':width,'height':844},service_workers='block',reduced_motion='reduce')
            run(context.new_page(),width); context.close()
            print(f'PASS Android update flow {width}',flush=True)
        context=browser.new_context(service_workers='block')
        page=context.new_page(); page.goto(URL); page.locator('#fab').wait_for()
        page.locator('[data-page="page-mine"]').click()
        page.get_by_role('button', name='应用设置', exact=True).click()
        expect(page.locator('[data-act="app-update"]')).to_have_count(0)
        context.close(); browser.close()
