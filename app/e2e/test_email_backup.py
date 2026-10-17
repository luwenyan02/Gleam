"""Android bridge contract for QQ SMTP UI; no real credentials, SMTP or Android claim."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_acceptance_fixes import seed
from test_m3 import open_backup, dialog_ok
from test_short_voice import MOCK_NATIVE
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/email-android'
MOCK_MAIL = '''(() => {
  const cap=window.Capacitor, original=cap.nativePromise;
  cap.PluginHeaders.push({name:'GleamMail',methods:['test','send'].map(name=>({name,rtype:'promise'}))});
  window.__mailSent=[];window.__mailCalls=[];window.__mailDrop=true;
  const accepted=new Set();
  cap.nativePromise=async (plugin,method,options={})=>{
    if(plugin!=='GleamMail') return original(plugin,method,options);
    window.__mailCalls.push({method,...options});
    if(options.authCode!=='abcdefghijklmnop') throw {code:'AUTH'};
    if(method==='test') return {};
    if(!accepted.has(options.requestId)){window.__mailSent.push(options);accepted.add(options.requestId)}
    if(window.__mailDrop){window.__mailDrop=false;throw {code:'UNCERTAIN'}}
    return {status:'accepted'};
  };
})()'''


def run(browser,width):
    context=browser.new_context(viewport={'width':width,'height':950},service_workers='block')
    page=context.new_page();page.add_init_script(MOCK_NATIVE+';'+MOCK_MAIL)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(URL);page.locator('#fab').wait_for();seed(page,count=2);open_backup(page)
    page.locator('[data-cb-prov="email"]').click()
    email=page.locator('#cloud-backup #email-backup')
    expect(email).to_be_visible()
    assert page.locator('[data-email="endpoint"]').count()==0
    email.locator('[data-email="username"]').fill('fictional@qq.com')
    email.locator('[data-email="authCode"]').fill('wrongwrongwrongw')
    email.locator('[data-email="recipient"]').fill('fictional.long.recipient@example.test')
    email.locator('[data-email-act="test"]').click()
    expect(page.locator('#toast')).to_contain_text('验证失败')
    email.locator('[data-email="authCode"]').fill('abcdefghijklmnop')
    email.locator('[data-email-act="test"]').click()
    expect(page.locator('#toast')).to_contain_text('配置已保存')
    expect(page.locator('#toast')).not_to_have_class('show',timeout=6000)
    assert page.evaluate('window.__mailSent.length')==0
    for scale in (1,1.3):
        page.evaluate('s=>document.documentElement.style.setProperty("--seed-type",String(s))',scale)
        page.wait_for_timeout(350)
        assert_usable(page,'#cloud-backup')
        page.locator('#cloud-backup').screenshot(path=str(OUT/f'cloud-{width}-{scale}.png'),animations='disabled')
    page.evaluate('document.documentElement.style.removeProperty("--seed-type")')
    email.locator('[data-email-act="send"]').click();page.locator('[data-email-close]').click()
    page.locator('#sheet.open').wait_for(state='detached');assert page.evaluate('window.__mailSent.length')==0
    email.locator('[data-email-act="send"]').click()
    page.locator('#email-p1').fill('fictional-password');page.locator('#email-p2').fill('fictional-password')
    page.locator('[data-email-confirm]').click()
    expect(page.locator('.eb-result')).to_contain_text('先检查收件箱')
    assert page.evaluate('window.__mailSent.length')==1
    page.locator('[data-email-confirm]').click()
    expect(page.locator('#toast')).to_contain_text('邮件服务器已接收')
    page.locator('#sheet.open').wait_for(state='detached')
    assert page.evaluate('window.__mailSent.length')==1
    history=page.locator('[aria-label="备份历史"]')
    expect(history.locator('[data-history-file]')).to_have_count(1)
    history.locator('[data-history-file]').click()
    page.locator('#rp-pwd').fill('fictional-password');page.locator('#sheet [data-act="ok"]').click()
    dialog_ok(page,'确认恢复此备份');dialog_ok(page,'恢复完成')
    expect(history.locator('[data-history-file]')).to_have_count(1)
    assert not errors,errors
    print(f'PASS Android email UI contract {width}; SMTP mocked',flush=True)
    context.close()

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as pw:
        browser=pw.chromium.launch()
        for width in (360,390,430,1280):run(browser,width)
        browser.close()
