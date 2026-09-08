# -*- coding: utf-8 -*-
"""Import and AI batch-deduplication regressions using fictional data only."""
import os
from playwright.sync_api import sync_playwright


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')


def seed(page, *, ai_pending=False):
    page.evaluate(
        '''async ({aiPending}) => {
          const openDb = () => new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const db = await openDb();
          const now = Date.now();
          const stores = [
            'entries', 'entryTags', 'accounts', 'categories', 'settings', 'importBatches',
            'tags', 'merchants', 'attachments', 'backupRecords',
          ];
          const tx = db.transaction(stores, 'readwrite');
          const done = new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          });
          for (const name of stores) tx.objectStore(name).clear();
          const accounts = tx.objectStore('accounts');
          accounts.put({ id: 1, name: '虚构现金', group: 'cash', balance: 10000, hidden: false,
            countInNetWorth: true, sortOrder: 1, createdAt: now, updatedAt: now });
          accounts.put({ id: 2, name: '虚构银行卡', group: 'debit', balance: 10000, hidden: false,
            countInNetWorth: true, sortOrder: 2, createdAt: now, updatedAt: now });
          const categories = tx.objectStore('categories');
          categories.put({ id: 1, name: '验收餐饮', icon: 'ic-bowl', kind: 'expense', sortOrder: 1,
            createdAt: now, updatedAt: now });
          categories.put({ id: 2, name: '验收午餐', icon: 'ic-bowl', kind: 'expense', parentId: 1, sortOrder: 2,
            createdAt: now, updatedAt: now });
          tx.objectStore('settings').put({ key: 'ai.pendingItems', value: [], updatedAt: now });
          await done;
          db.close();
        }''',
        {'aiPending': ai_pending},
    )
    page.reload()
    page.locator('#fab').wait_for()
    if ai_pending:
        page.evaluate(
            '''async () => {
              const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('GleamDB');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              const tx = db.transaction('settings', 'readwrite');
              const done = new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
              });
              const now = Date.now();
              tx.objectStore('settings').put({ key: 'ai.pendingItems', value: [
                { tempId: 'fiction-ai-a', status: 'ready', source: 'paste', type: 'expense', amount: 2000,
                  categoryName: '验收餐饮/验收午餐', accountName: '虚构现金',
                  note: '虚构同时同额账单A', occurredAt: 1788339600000, confidence: 10, createdAt: now },
                { tempId: 'fiction-ai-b', status: 'ready', source: 'paste', type: 'expense', amount: 2000,
                  categoryName: '验收餐饮/验收午餐', accountName: '虚构银行卡',
                  note: '虚构同时同额账单B', occurredAt: 1788339600000, confidence: 10, createdAt: now },
              ], updatedAt: now });
              await done;
              db.close();
            }'''
        )
        page.reload()
        page.locator('#fab').wait_for()


def snapshot(page):
    return page.evaluate(
        '''async () => {
          const openDb = () => new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const read = (store) => new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const db = await openDb();
          const names = [
            'entries', 'entryTags', 'accounts', 'categories', 'settings', 'importBatches',
            'tags', 'merchants', 'attachments', 'backupRecords',
          ];
          const tx = db.transaction(names, 'readonly');
          const rows = await Promise.all(names.map((name) => read(tx.objectStore(name))));
          db.close();
          const byName = Object.fromEntries(names.map((name, index) => [name, rows[index]]));
          return {
            entries: byName.entries,
            entryTags: byName.entryTags,
            accounts: byName.accounts,
            categories: byName.categories,
            importBatches: byName.importBatches,
            backupRecords: byName.backupRecords,
            tags: byName.tags,
            merchants: byName.merchants,
            attachments: byName.attachments.map(({id, size, mime}) => ({id, size, mime})),
            pending: byName.settings.find((row) => row.key === 'ai.pendingItems')?.value ?? [],
          };
        }'''
    )


def snapshot_count(page):
    return page.evaluate(
        '''async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamSnapshotDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const count = await new Promise((resolve, reject) => {
            const request = db.transaction('snapshots').objectStore('snapshots').count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          db.close();
          return count;
        }'''
    )


def seed_ai_single(page, *, existing=False, merchant=True):
    seed(page)
    page.evaluate(
        '''async ({existing, merchant}) => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const tx = db.transaction(['entries', 'accounts', 'settings', 'attachments'], 'readwrite');
          const done = new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          });
          const now = Date.now();
          const item = {
            tempId: 'fiction-ai-single', status: 'ready', source: 'pick', type: 'expense', amount: 2000,
            categoryName: '验收餐饮/验收午餐', accountName: '虚构现金',
            note: '虚构AI原子确认', occurredAt: 1788339600000, confidence: 10, attachmentId: 1, createdAt: now,
          };
          if (merchant) item.merchantName = '虚构AI商家';
          tx.objectStore('settings').put({ key: 'ai.pendingItems', value: [item], updatedAt: now });
          tx.objectStore('attachments').put({ id: 1, mime: 'text/plain', name: '虚构附件.txt', size: 7,
            blob: new Blob(['fiction'], {type: 'text/plain'}), createdAt: now, updatedAt: now });
          if (existing) {
            tx.objectStore('entries').put({ id: 1, type: 'expense', amount: 2000, occurredAt: 1788339600000,
              categoryId: 2, accountId: 1, note: '虚构已有账单', reimburseStatus: 'none', deletedAt: 0,
              createdAt: now, updatedAt: now });
            tx.objectStore('accounts').put({ id: 1, name: '虚构现金', group: 'cash', balance: 8000,
              hidden: false, countInNetWorth: true, sortOrder: 1, createdAt: now, updatedAt: now });
          }
          await done;
          db.close();
        }''',
        {'existing': existing, 'merchant': merchant},
    )
    page.reload()
    page.locator('#fab').wait_for()


def open_backup(page):
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-backup"]').click()
    page.locator('#sp-backup [data-act="pick-import"]').wait_for()


def choose_rows(page, rows, name):
    headers = [
        '日期时间', '类型', '类别', '金额', '币种', '收付款人',
        '收付账户', '参与人', '标签', '商家', '属性', '备注',
    ]
    content = '\ufeff' + '\n'.join('\t'.join(row) for row in (headers, *rows))
    with page.expect_file_chooser() as chooser:
        page.locator('#sp-backup [data-act="pick-import"]').click()
    chooser.value.set_files({
        'name': name,
        'mimeType': 'application/vnd.ms-excel',
        'buffer': content.encode('utf-8'),
    })


def import_rows(page, rows, name):
    choose_rows(page, rows, name)
    page.locator('#sp-import [data-act="to-map"]').click()
    page.locator('#sp-import [data-act="run"]').click()
    page.locator('#sp-import .imp-report').wait_for(timeout=20000)


def duplicate_import(page):
    seed(page)
    open_backup(page)
    duplicate = [
        '2026-09-03 09:00', '支出', '验收餐饮/验收午餐', '12', '人民币', '',
        '虚构现金', '自己', '', '', '', '虚构同批重复行',
    ]
    import_rows(page, [duplicate, duplicate], '虚构同批重复.xls')

    data = snapshot(page)
    assert len(data['entries']) == 1, data
    assert data['entries'][0]['amount'] == 1200, data
    balances = {account['id']: account['balance'] for account in data['accounts']}
    assert balances[1] == 8800, data


def foreign_share_import(page):
    seed(page)
    open_backup(page)
    import_rows(page, [[
        '2026-09-02 09:00', '支出', '验收餐饮/验收午餐', '10', '美元', '',
        '虚构现金', '自己:4.00, 同事:6.00', '', '', '', '虚构外币分摊',
    ]], '虚构外币分摊.xls')

    data = snapshot(page)
    assert len(data['entries']) == 1, data
    assert data['entries'][0]['amount'] == 2856, data
    balances = {account['id']: account['balance'] for account in data['accounts']}
    assert balances[1] == 7144, data


def ai_same_time_amount_different_accounts(page):
    seed(page, ai_pending=True)
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-ai-inbox"]').click()
    page.locator('#sp-ai-inbox [data-act="confirm-all"]').wait_for()
    page.locator('#sp-ai-inbox [data-act="confirm-all"]').click()
    page.wait_for_function(
        '''async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const count = await new Promise((resolve, reject) => {
            const request = db.transaction('entries').objectStore('entries').count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          db.close();
          return count >= 1;
        }'''
    )

    data = snapshot(page)
    assert len(data['entries']) == 2, data
    assert data['pending'] == [], data
    assert {entry['accountId'] for entry in data['entries']} == {1, 2}, data


def import_retry_is_atomic(page):
    seed(page)
    open_backup(page)
    row = [
        '2026-09-03 09:00', '支出', '审查大类/审查小类', '12', '人民币', '',
        '审查自动账户', '自己', '审查标签', '审查模拟商家', '', '虚构导入重试',
    ]
    choose_rows(page, [row], '虚构失败重试.xls')
    page.locator('#sp-import [data-act="to-map"]').click()
    page.locator('#sp-import [data-act="auto-all"]').click()
    page.evaluate(
        '''() => {
          const original = IDBObjectStore.prototype.put;
          let fail = true;
          window.__importFaultFired = false;
          IDBObjectStore.prototype.put = function(value, ...args) {
            if (fail && this.name === 'merchants' && value?.name === '审查模拟商家' && value?.useCount === 1) {
              fail = false;
              window.__importFaultFired = true;
              throw new DOMException('审查模拟：导入后商家更新失败', 'AbortError');
            }
            return original.call(this, value, ...args);
          };
        }'''
    )

    page.locator('#sp-import [data-act="run"]').click()
    page.wait_for_function('window.__importFaultFired === true')
    page.locator('#sp-import [data-act="run"]').wait_for()
    first = snapshot(page)
    first_snapshot_count = snapshot_count(page)

    page.locator('#sp-import [data-act="run"]').click()
    page.locator('#sp-import .imp-report').wait_for(timeout=20000)
    second = snapshot(page)
    second_snapshot_count = snapshot_count(page)

    first_new_accounts = [account for account in first['accounts'] if account['name'] == '审查自动账户']
    first_new_categories = [category for category in first['categories'] if category['name'].startswith('审查')]
    second_new_accounts = [account for account in second['accounts'] if account['name'] == '审查自动账户']
    second_new_categories = [category for category in second['categories'] if category['name'].startswith('审查')]
    assert len(first['entries']) == 0 and first_new_accounts == [] and first_new_categories == [], {
        'afterFirstFailure': first, 'afterRetry': second,
    }
    assert first['tags'] == [] and first['merchants'] == [] and first['importBatches'] == [], first
    assert first_snapshot_count == 1, first_snapshot_count
    assert len(second['entries']) == 1 and len(second_new_accounts) == 1, second
    assert len(second_new_categories) == 2 and len(second['tags']) == 1 and len(second['merchants']) == 1, second
    assert len(second['entryTags']) == 1 and len(second['importBatches']) == 1, second
    assert second_snapshot_count == 2, second_snapshot_count
    assert second_new_accounts[0]['balance'] == -1200, second
    assert second['merchants'][0]['useCount'] == 1, second


def ai_queue_failure_is_atomic(page):
    seed_ai_single(page)
    page.evaluate(
        '''() => {
          const original = IDBObjectStore.prototype.put;
          let fail = true;
          window.__aiQueueFaultFired = false;
          IDBObjectStore.prototype.put = function(value, ...args) {
            if (fail && this.name === 'settings' && value?.key === 'ai.pendingItems'
              && Array.isArray(value?.value) && value.value.length === 0) {
              fail = false;
              window.__aiQueueFaultFired = true;
              throw new DOMException('审查模拟：AI队列消费失败', 'AbortError');
            }
            return original.call(this, value, ...args);
          };
        }'''
    )
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-ai-inbox"]').click()
    page.locator('#sp-ai-inbox [data-act="confirm-all"]').wait_for()
    page.locator('#sp-ai-inbox [data-act="confirm-all"]').click()
    page.wait_for_function('window.__aiQueueFaultFired === true')
    page.wait_for_timeout(200)
    first = snapshot(page)

    page.locator('#sp-ai-inbox [data-act="confirm-all"]').click()
    page.wait_for_timeout(500)
    second = snapshot(page)

    assert len(first['entries']) == 0 and len(first['pending']) == 1 and len(first['attachments']) == 1, {
        'afterFirstFailure': first, 'afterRetry': second,
    }
    assert first['merchants'] == [] and first['importBatches'] == [], first
    assert len(second['entries']) == 1 and second['pending'] == [] and second['attachments'] == [], second
    assert len(second['merchants']) == 1 and second['merchants'][0]['useCount'] == 1, second
    assert len(second['importBatches']) == 1, second


def ai_explicit_duplicate_double_confirm(page):
    seed_ai_single(page, existing=True, merchant=False)
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-ai-inbox"]').click()
    confirm = page.locator('#sp-ai-inbox [data-temp="fiction-ai-single"] [data-act="confirm"]')
    confirm.wait_for()
    confirm.click()
    confirm = page.get_by_role('button', name='仍要入账', exact=True)
    confirm.wait_for()
    page.evaluate(
        '''() => {
          const button = document.querySelector('#sp-ai-inbox [data-temp="fiction-ai-single"] [data-act="confirm"]');
          button.click();
          button.click();
        }'''
    )
    page.wait_for_timeout(700)

    data = snapshot(page)
    assert len(data['entries']) == 2, data
    assert data['pending'] == [] and data['attachments'] == [], data
    assert {account['id']: account['balance'] for account in data['accounts']}[1] == 6000, data
    assert data['merchants'] == [], data


if __name__ == '__main__':
    failures = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        cases = (
            ('duplicate_import', duplicate_import),
            ('foreign_share_import', foreign_share_import),
            ('ai_same_time_amount_different_accounts', ai_same_time_amount_different_accounts),
            ('import_retry_is_atomic', import_retry_is_atomic),
            ('ai_queue_failure_is_atomic', ai_queue_failure_is_atomic),
            ('ai_explicit_duplicate_double_confirm', ai_explicit_duplicate_double_confirm),
        )
        selected = os.environ.get('GLEAM_E2E_CASE')
        if selected:
            names = set(selected.split(','))
            cases = tuple((name, case) for name, case in cases if name in names)
        for name, case in cases:
            context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
            page = context.new_page()
            page.set_default_timeout(7000)
            try:
                page.goto(URL)
                page.wait_for_load_state('networkidle')
                page.locator('#fab').wait_for()
                case(page)
                print(f'PASS {name}', flush=True)
            except Exception as error:
                failures.append(name)
                print(f'FAIL {name}: {error}', flush=True)
            finally:
                context.close()
        browser.close()
    raise SystemExit(1 if failures else 0)
