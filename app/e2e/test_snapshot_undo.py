"""Snapshot undo feedback, rollback and mutual exclusion with fictional data only."""
import base64
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright
from test_acceptance_fixes import seed
from test_restore_progress import READ, archive

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/snapshot-undo'
CONTROLS = '#sp-backup [data-undo], #sp-backup [data-history-file], #sp-backup [data-act="restore"]'
INSTRUMENT = r'''(() => {
  window.undoAudit = { active: false, writes: 0, snapshotReads: 0, fileReads: 0, progress: [] };
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
    if (undoAudit.active && this.name === 'GleamDB' && mode === 'readwrite'
      && Array.from(typeof stores === 'string' ? [stores] : stores).includes('entries')) undoAudit.writes++;
    return transaction.call(this, stores, mode, ...args);
  };
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function(...args) {
    if (undoAudit.active && this.name === 'snapshotContents') undoAudit.snapshotReads++;
    if (undoAudit.active && this.transaction.db.name === 'GleamBackupFilesDB' && this.name === 'files') undoAudit.fileReads++;
    return get.apply(this, args);
  };
  const add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function(value, ...args) {
    if (window.failUndo === 'late' && this.name === 'entries' && value.id === 1501) value = {...value, id: 1};
    return add.call(this, value, ...args);
  };
  const remove = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function(...args) {
    if (window.failUndo === 'cleanup' && this.name === 'snapshotContents') throw new Error('synthetic cleanup failure');
    return remove.apply(this, args);
  };
  addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
    const progress = document.querySelector('.restore-progress progress');
    if (undoAudit.active && progress) undoAudit.progress.push({value: progress.value, max: progress.max});
  }).observe(document.documentElement, {childList: true, subtree: true, attributes: true}));
})();'''


def open_backup(page):
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-backup"]').click()
    page.locator('#sp-backup [data-act="restore"]').first.wait_for()


def prepare(browser, count=3001, width=400, dark=False):
    context = browser.new_context(viewport={'width': width, 'height': 890},
        service_workers='block', timezone_id='Asia/Shanghai')
    context.route('**/*', lambda route: route.continue_()
        if urlsplit(route.request.url).netloc == urlsplit(URL).netloc else route.abort())
    context.add_init_script(INSTRUMENT)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.set_default_timeout(10000)
    page.goto(URL)
    page.locator('#fab').wait_for()
    seed(page, count=1, amount=100)
    before = page.evaluate(READ)
    # Opening once initializes the independent snapshot and local-file databases.
    open_backup(page)
    page.locator('#sp-backup .sub-head [data-act="back"]').click()
    page.locator('#sp-backup').wait_for(state='detached')
    archive_path = archive(json.loads(json.dumps(before)), 11)
    page.evaluate(r'''async ({count, backup}) => {
      const open = name => new Promise((resolve, reject) => {
        const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const done = tx => new Promise((resolve, reject) => {
        tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
      });
      const db = await open('GleamDB');
      const names = [...db.objectStoreNames], tx = db.transaction(names);
      const dump = Object.fromEntries(await Promise.all(names.map(name => new Promise(resolve => {
        const request = tx.objectStore(name).getAll(); request.onsuccess = () => resolve([name, request.result]);
      }))));
      db.close();
      dump.entries = Array.from({length: count}, (_, index) => ({...dump.entries[0], id: index + 1,
        occurredAt: 1577836800000 + index * 1000, note: '虚构快照账单'}));
      dump.accounts[0].balance = -count * 100;
      const snapshot = await open('GleamSnapshotDB');
      const write = snapshot.transaction(['snapshots', 'snapshotContents'], 'readwrite');
      write.objectStore('snapshots').put({id: 1, createdAt: Date.now(), reason: 'restore', label: '虚构恢复前快照',
        counts: Object.fromEntries(names.map(name => [name, dump[name].length]))});
      write.objectStore('snapshotContents').put({id: 1, tables: dump});
      await done(write); snapshot.close();
      const files = await open('GleamBackupFilesDB');
      const fileWrite = files.transaction('files', 'readwrite');
      const blob = new Blob([Uint8Array.from(atob(backup), ch => ch.charCodeAt(0))]);
      fileWrite.objectStore('files').put({id: 'fictional', savedAt: Date.now(), blob,
        record: {fileName: 'fictional.skbak', provider: 'local', size: blob.size,
          entryCount: 11, encrypted: false, createdAt: Date.now(), updatedAt: Date.now()}});
      await done(fileWrite); files.close();
    }''', {'count': count, 'backup': base64.b64encode(archive_path.read_bytes()).decode()})
    if dark:
        page.evaluate('document.documentElement.dataset.theme="dark";document.documentElement.style.setProperty("--seed-type","1.3")')
    page.locator('#page-mine [data-sub="sp-backup"]').click()
    page.locator('#sp-backup [data-undo="1"]').wait_for()
    page.evaluate('undoAudit.active = true')
    return context, page, before, errors


def click_undo(page):
    page.locator('#sp-backup [data-undo="1"]').click()
    expect(page.locator('#dialog-scrim')).to_contain_text('之后记的账会丢失')


def assert_controls(page, disabled):
    for button in page.locator(CONTROLS).all():
        (expect(button).to_be_disabled if disabled else expect(button).to_be_enabled)()


def snapshot_count(page):
    return page.evaluate('''async () => {
      const db = await new Promise(resolve => {const request = indexedDB.open('GleamSnapshotDB'); request.onsuccess = () => resolve(request.result)});
      const count = await new Promise(resolve => {const request = db.transaction('snapshots').objectStore('snapshots').count(); request.onsuccess = () => resolve(request.result)});
      db.close(); return count;
    }''')


def failure(browser, mode, width=400, dark=False):
    context, page, before, errors = prepare(browser, count=3001 if mode == 'late' else 3, width=width, dark=dark)
    try:
        click_undo(page)
        if mode == 'missing':
            page.evaluate('''async () => {
              const db = await new Promise(resolve => {const q=indexedDB.open('GleamSnapshotDB');q.onsuccess=()=>resolve(q.result)});
              const tx=db.transaction(['snapshots','snapshotContents'],'readwrite');tx.objectStore('snapshots').clear();tx.objectStore('snapshotContents').clear();
              await new Promise(resolve => tx.oncomplete=resolve);db.close();
            }''')
        else:
            page.evaluate('mode => window.failUndo = mode', mode)
        page.locator('#dialog-scrim [data-act="ok"]').click()
        dialog = page.locator('#dialog-scrim.show')
        if mode == 'cleanup':
            expect(dialog).to_contain_text('数据已恢复')
            expect(dialog).to_contain_text('快照清理未完成')
            expect(dialog).to_contain_text('请勿重复撤销')
            expect(page.locator('#sp-backup')).to_contain_text('3 笔有效账单')
        else:
            expect(dialog).to_contain_text('撤销未完成')
            expect(dialog).to_contain_text('原数据未被替换')
            if mode == 'missing': expect(dialog).to_contain_text('快照不存在')
        after = page.evaluate(READ)
        if mode == 'cleanup':
            assert len(after['entries']) == 3 and after['accounts'][0]['balance'] == -300
        else:
            assert after == before, mode
        assert snapshot_count(page) == (0 if mode == 'missing' else 1)
        assert_controls(page, True)
        expect(page.locator('.restore-progress')).to_have_count(0)
        # A committed restore reapplies saved settings; explicitly exercise the requested error theme.
        if dark:
            page.evaluate('document.documentElement.dataset.theme="dark";document.documentElement.style.setProperty("--seed-type","1.3")')
        assert dialog.locator('.dialog').evaluate('e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&e.scrollWidth<=e.clientWidth+1}')
        page.screenshot(path=str(OUT/f'{mode}-{width}-{dark}.png'), animations='disabled')
        page.locator('#dialog-scrim [data-act="ok"]').click()
        assert_controls(page, False)
        if mode == 'missing': expect(page.locator('#sp-backup [data-undo]')).to_have_count(0)
        assert not errors, errors
        print('PASS snapshot undo', mode, width, dark, flush=True)
    finally:
        context.close()


def cancellation_and_restore_lock(browser):
    context, page, before, errors = prepare(browser)
    try:
        click_undo(page)
        assert_controls(page, True)
        # Deliberately dispatch duplicate events despite disabled/inert controls.
        page.evaluate('''() => { for (const selector of ['[data-undo="1"]', '[data-history-file]'])
          document.querySelector('#sp-backup '+selector).dispatchEvent(new MouseEvent('click', {bubbles: true})); }''')
        expect(page.locator('#dialog-scrim')).to_contain_text('撤销到该快照？')
        assert page.evaluate('undoAudit.fileReads') == 0
        page.locator('#dialog-scrim [data-act="cancel"]').click()
        assert_controls(page, False)
        assert page.evaluate(READ) == before
        page.locator('#sp-backup .sub-head [data-act="back"]').click()
        page.locator('#sp-backup').wait_for(state='detached')
        page.locator('#page-mine [data-sub="sp-backup"]').click()
        page.locator('#sp-backup [data-history-file]').click()
        expect(page.locator('#dialog-scrim.show')).to_contain_text('确认恢复此备份？')
        assert_controls(page, True)
        page.evaluate('document.querySelector("#sp-backup [data-undo]").dispatchEvent(new MouseEvent("click", {bubbles: true}))')
        expect(page.locator('#dialog-scrim')).to_contain_text('确认恢复此备份？')
        assert page.evaluate('undoAudit.snapshotReads') == 0
        page.locator('#dialog-scrim [data-act="cancel"]').click()
        assert_controls(page, False)
        assert page.evaluate(READ) == before
        assert page.evaluate('undoAudit.writes') == 0
        assert not errors, errors
        print('PASS snapshot undo cancellation, page reentry and bidirectional restore lock', flush=True)
    finally:
        context.close()


def success(browser, width, dark=False):
    context, page, _, errors = prepare(browser, count=20000, width=width, dark=dark)
    try:
        click_undo(page)
        assert_controls(page, True)
        page.locator('#dialog-scrim [data-act="ok"]').click()
        progress = page.locator('.restore-progress')
        expect(progress).to_be_visible()
        assert_controls(page, True)
        page.keyboard.press('Escape')
        page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))')
        expect(progress).to_be_visible()
        page.screenshot(path=str(OUT/f'progress-{width}-{dark}.png'), animations='disabled')
        assert progress.locator('.dialog').evaluate('e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}')
        expect(page.locator('#toast')).to_contain_text('已撤销到快照时点', timeout=30000)
        expect(progress).to_have_count(0)
        expect(page.locator('#sp-backup [data-undo]')).to_have_count(0)
        assert_controls(page, False)
        expect(page.locator('#sp-backup')).to_contain_text('20,000 笔有效账单')
        after = page.evaluate(READ)
        assert len(after['entries']) == 20000 and after['accounts'][0]['balance'] == -2000000
        assert snapshot_count(page) == 0
        audit = page.evaluate('undoAudit')
        assert audit['writes'] == 1 and audit['snapshotReads'] == 1, audit
        assert any(0 < step['value'] < step['max'] for step in audit['progress']), audit
        page.locator('#sp-backup .sub-head [data-act="back"]').click()
        page.locator('#sp-backup').wait_for(state='detached')
        expect(page.locator('#page-mine')).to_be_visible()
        assert not errors, errors
        print('PASS snapshot undo success/progress', width, dark, flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    # archive() is shared with the standard restore regression.
    from test_restore_progress import OUT as ARCHIVE_OUT
    ARCHIVE_OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
        for case in ('late', 'cleanup', 'missing'):
            if mode in ('all', case): failure(browser, case)
        if mode in ('all', 'errors-layout'):
            failure(browser, 'cleanup', 360, True)
            failure(browser, 'late', 390, True)
        if mode in ('all', 'lock'): cancellation_and_restore_lock(browser)
        if mode in ('all', 'success'):
            for width, dark in ((360, False), (390, False), (400, True), (430, False), (1280, False)):
                success(browser, width, dark)
        browser.close()
