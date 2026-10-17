"""Web backup history, restore confirmation, legacy settings, independent file selection."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_acceptance_fixes import seed
from test_m3 import open_backup, do_backup, do_restore, dialog_ok
from test_browser_usability import assert_usable
URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4601/')
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/backup-history'

def run(browser,width):
    context=browser.new_context(viewport={'width':width,'height':950},service_workers='block',accept_downloads=True)
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(URL);page.locator('#fab').wait_for();seed(page,count=2)
    page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['settings','backupRecords'],'readwrite');
      for(const [key,value] of [['backup.auto','daily'],['notification.backup',true],['backup.lastBackupAt',0],['cloud.provider','email']]) tx.objectStore('settings').put({key,value,updatedAt:1});
      tx.objectStore('backupRecords').add({fileName:'虚构旧备份这是一个很长的名字_20261017.skbak',size:1024,provider:'local',entryCount:2,encrypted:false,createdAt:1,updatedAt:1});
      await new Promise(r=>tx.oncomplete=r);db.close();
    }''')
    page.reload();page.locator('#fab').wait_for();open_backup(page)
    assert page.locator('[data-cb-prov="email"]').count()==0
    assert page.locator('#email-backup').count()==0
    assert '备份提醒' not in page.locator('#sp-backup').inner_text()
    history=page.locator('[aria-label="备份历史"]')
    expect(history.locator('[data-history-file]')).to_have_count(0)
    with page.expect_file_chooser():history.get_by_role('button',name='选文件恢复',exact=True).click()
    downloaded=do_backup(page,password='fictional-password')
    expect(history.locator('[data-history-file]')).to_have_count(1)
    expect(page.locator('#toast')).not_to_have_class('show',timeout=6000)
    for scale in (1,1.3):
        page.evaluate('s=>document.documentElement.style.setProperty("--seed-type",String(s))',scale)
        history.scroll_into_view_if_needed();page.wait_for_timeout(350)
        assert_usable(page,'#sp-backup')
        history.screenshot(path=str(OUT/f'history-{width}-{scale}.png'),animations='disabled')
    page.evaluate('document.documentElement.style.removeProperty("--seed-type")')
    history.locator('[data-history-file]').click()
    page.locator('#rp-pwd').fill('wrong-password');page.locator('#sheet [data-act="ok"]').click()
    dialog_ok(page,'恢复未执行')
    history.locator('[data-history-file]').click()
    page.locator('#rp-pwd').fill('fictional-password');page.locator('#sheet [data-act="ok"]').click()
    dialog_ok(page,'确认恢复此备份');dialog_ok(page,'恢复完成')
    expect(history.locator('[data-history-file]')).to_have_count(1)
    do_restore(page,downloaded,password='fictional-password')
    expect(history.locator('[data-history-file]')).to_have_count(1)
    page.locator('#sp-backup .sub-head [data-act="back"]').click()
    page.get_by_role('button',name='应用设置',exact=True).click()
    expect(page.locator('#sp-settings')).not_to_contain_text('备份提醒')
    assert page.locator('#sp-settings [data-sw="ntf-backup"]').count()==0
    assert not errors,errors
    print(f'PASS backup history {width}: web hides email; direct and file restore',flush=True)
    context.close()
if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as pw:
        browser=pw.chromium.launch()
        for width in (360,390,430,1280):run(browser,width)
        browser.close()
