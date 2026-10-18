"""Business backup counts and optional help, with fictional data and no services."""
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright
from test_acceptance_fixes import seed
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4602/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/backup-settings-clarity'


def ledger_snapshot(page):
    return page.evaluate('''async () => {
      const db = await new Promise((resolve, reject) => {
        const q = indexedDB.open('GleamDB'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
      });
      const names = ['entries', 'accounts', 'lifeNotes', 'entryTags'];
      const tx = db.transaction(names, 'readonly');
      const rows = await Promise.all(names.map(name => new Promise(resolve => {
        const q = tx.objectStore(name).getAll(); q.onsuccess = () => resolve([name, q.result]);
      })));
      db.close(); return Object.fromEntries(rows);
    }''')


def run(browser, width, scheme):
    context = browser.new_context(viewport={'width': width, 'height': 844}, color_scheme=scheme, service_workers='block')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    origin = urlsplit(URL).netloc
    page.route('**/*', lambda route: route.continue_() if urlsplit(route.request.url).netloc == origin else route.abort())
    page.goto(URL); page.locator('#fab').wait_for(); seed(page, count=2)
    page.evaluate('''async () => {
      const db = await new Promise(resolve => { const q = indexedDB.open('GleamDB'); q.onsuccess = () => resolve(q.result); });
      const tx = db.transaction(['entries', 'accounts', 'lifeNotes', 'entryTags', 'settings'], 'readwrite');
      tx.objectStore('entries').put({id: 3, type: 'income', amount: 200, accountId: 1, occurredAt: 1, createdAt: 1, updatedAt: 1, deletedAt: Date.now(), reimburseStatus: 'none'});
      tx.objectStore('accounts').put({id: 99, name: '虚构隐藏账户', group: 'other', balance: 0, hidden: true, countInNetWorth: false, sortOrder: 9, createdAt: 1, updatedAt: 1});
      tx.objectStore('lifeNotes').clear();
      for (const [id, deletedAt] of [[1, 0], [2, Date.now()]]) tx.objectStore('lifeNotes').put({id, kind: 'diary', body: '虚构生活记录', occurredAt: 1, createdAt: 1, updatedAt: 1, deletedAt});
      for (let i = 1; i <= 30; i++) tx.objectStore('entryTags').put({id: i, entryId: 1, tagId: i});
      tx.objectStore('settings').put({key: 'cloud.provider', value: 'none', updatedAt: 1});
      await new Promise((resolve, reject) => {tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);}); db.close();
    }''')
    page.reload(); page.locator('#fab').wait_for()
    before = ledger_snapshot(page)
    page.locator('[data-page="page-mine"]').click()
    page.get_by_role('button', name='应用设置', exact=True).click()
    settings = page.locator('#sp-settings')
    expect(settings).to_contain_text('自动入账阈值')
    voice = settings.locator('section[aria-label="百炼短语音"]')
    details = voice.locator('details')
    expect(details).not_to_have_attribute('open', '')
    expect(voice.locator('#voice-bailian-workspace')).not_to_be_visible()
    voice.locator('summary').press('Enter')
    expect(details).to_have_attribute('open', '')
    expect(voice.locator('#voice-bailian-workspace')).to_be_disabled()
    expect(voice.locator('[data-voice-test]')).to_be_disabled()
    # An unrelated settings refresh must not close the help the user opened.
    settings.locator(f'[data-theme-mode="{scheme}"]').click()
    expect(settings.locator(f'[data-theme-mode="{scheme}"]')).to_have_class('chip active')
    expect(details).to_have_attribute('open', '')
    voice.locator('summary').press('Space')
    expect(voice.locator('#voice-bailian-workspace')).not_to_be_visible()
    assert_usable(page, '#sp-settings')
    voice.screenshot(path=str(OUT / f'web-voice-{width}-{scheme}.png'), animations='disabled')
    settings.locator('.sub-head [data-act="back"]').click()
    page.locator('[data-sub="sp-backup"]').click()
    backup = page.locator('#sp-backup')
    status = backup.locator('[aria-label="立即备份"]')
    expect(status.locator('.big')).to_have_text('2 笔有效账单')
    expected_accounts = len(before['accounts'])
    expect(status.locator('.bs-stats')).to_have_text(f'回收站账单 1 账户 {expected_accounts} 生活记录 1')
    assert '条记录' not in status.inner_text()
    expect(backup).to_contain_text('恢复将全量替换')
    retention = backup.locator('details').filter(has=page.get_by_text('本机副本说明', exact=True))
    expect(retention).not_to_have_attribute('open', '')
    retention.locator('summary').press('Enter')
    expect(retention).to_contain_text('卸载或清除应用数据会丢失本机副本')
    retention.locator('summary').press('Space')
    assert_usable(page, '#sp-backup')
    status.screenshot(path=str(OUT / f'backup-counts-{width}-{scheme}.png'), animations='disabled')
    backup.locator('.sub-head [data-act="back"]').click()
    page.locator('[data-sub="sp-reimburse"]').click()
    reimbursement = page.locator('#sp-reimburse')
    expect(reimbursement.locator('#rb-list')).to_contain_text('记账时勾选「报销」')
    expect(reimbursement.locator('#rb-mode-summary')).to_have_text('到账冲抵原支出，不计入收入。')
    reimbursement.locator('#rb-mode').click()
    expect(reimbursement.locator('#rb-mode-summary')).to_have_text('到账计入「报销」收入。')
    reimbursement.locator('.rb-details summary').press('Enter')
    expect(reimbursement.locator('.rb-details')).to_contain_text('差额继续计入支出')
    assert_usable(page, '#sp-reimburse')
    assert ledger_snapshot(page) == before
    assert not errors, errors
    context.close()
    print(f'PASS backup and optional settings help {width} {scheme}', flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for width in (360, 390, 430, 1280):
            for scheme in ('light', 'dark'):
                run(browser, width, scheme)
        browser.close()
