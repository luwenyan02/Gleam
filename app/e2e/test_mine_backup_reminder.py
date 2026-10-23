"""Device-local backup status and quiet reminder; fictional data and real local download."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_acceptance_fixes import seed
from test_m3 import do_backup
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/mine-backup-reminder'


def open_mine(page):
    page.locator('[data-page="page-mine"]').click()
    expect(page.locator('#page-mine [data-mine-stats]')).to_contain_text('条流水')


def run(browser, width, dark=False):
    context = browser.new_context(viewport={'width': width, 'height': 890},
                                  device_scale_factor=3 if width == 400 else 1,
                                  service_workers='block', accept_downloads=True)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL)
    page.locator('#fab').wait_for()
    seed(page, count=0)
    open_mine(page)
    reminder = page.locator('#page-mine [data-backup-reminder]')
    note = page.locator('#page-mine [data-sub="sp-backup"] .row-note')
    expect(note).to_have_text('未备份')
    expect(reminder).to_be_hidden()

    # A photo-only library also contains user data worth backing up, even with zero ledger entries.
    page.evaluate('''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction(['lifeNotes','attachments'],'readwrite'),now=Date.now();
      const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
      const blob=new Blob([png],{type:'image/png'});
      tx.objectStore('attachments').put({id:1,blob,mime:'image/png',size:blob.size,createdAt:now,updatedAt:now});
      tx.objectStore('lifeNotes').put({id:1,kind:'photo',title:'虚构生活照片',photoRefs:[1],occurredAt:now,deletedAt:0,createdAt:now,updatedAt:now});
      await new Promise(resolve=>tx.oncomplete=resolve);db.close();
    }''')
    page.locator('#tab-home').click(); open_mine(page)
    expect(page.locator('#page-mine [data-mine-stats]')).to_contain_text('0 条流水')
    expect(reminder).to_be_visible()
    # Deleted life records must not turn an otherwise empty library into a reminder.
    page.evaluate('''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('lifeNotes','readwrite'),store=tx.objectStore('lifeNotes'),r=store.get(1);
      r.onsuccess=()=>store.put({...r.result,deletedAt:Date.now()});
      await new Promise(resolve=>tx.oncomplete=resolve);db.close();
    }''')
    page.locator('#tab-home').click(); open_mine(page)
    expect(reminder).to_be_hidden()

    seed(page, count=2)
    # Imported backup timestamps are not proof this device has made a backup.
    page.evaluate('''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('settings','readwrite');
      tx.objectStore('settings').put({key:'backup.lastBackupAt',value:Date.now(),updatedAt:Date.now()});
      await new Promise(resolve=>tx.oncomplete=resolve);db.close();
    }''')
    open_mine(page)
    expect(note).to_have_text('未备份')
    expect(reminder).to_be_visible()
    page.evaluate('''dark=>{
      document.documentElement.dataset.theme=dark?'dark':'light';
      if(dark)document.documentElement.style.setProperty('--seed-type','1.3');
    }''', dark)
    reminder.scroll_into_view_if_needed()
    page.wait_for_timeout(350)
    assert_usable(page, '#page-mine')
    page.screenshot(path=str(OUT / f'mine-reminder-{width}-{dark}.png'), animations='disabled')
    reminder.locator('[data-dismiss-backup]').click()
    expect(reminder).to_be_hidden()
    expect(page.locator('#page-mine [data-sub="sp-backup"]')).to_be_focused()
    page.reload(); page.locator('#fab').wait_for(); open_mine(page)
    expect(reminder).to_be_hidden()

    # After the dismissal expires, navigating back should show the prompt again.
    page.evaluate("localStorage.setItem('gleam.backup.reminderDismissedAt',String(Date.now()-8*86400000))")
    page.reload(); page.locator('#fab').wait_for(); open_mine(page)
    expect(reminder).to_be_visible()
    reminder.locator('[data-backup-now]').click()
    do_backup(page)
    page.locator('#sp-backup .sub-head [data-act="back"]').click()
    expect(note).to_contain_text('最近')
    expect(reminder).to_be_hidden()
    page.reload(); page.locator('#fab').wait_for(); open_mine(page)
    expect(note).to_contain_text('最近')
    expect(reminder).to_be_hidden()
    assert not errors, errors
    print(f'PASS Mine backup reminder {width}: empty, life-only, deleted life, import, dismiss, expiry, download and reload', flush=True)
    context.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for width in (360, 390, 400, 430, 1280):
            run(browser, width, dark=width in (400, 430))
        browser.close()
