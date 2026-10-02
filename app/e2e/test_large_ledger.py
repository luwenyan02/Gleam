"""一万笔虚构账单下的筛选、分页和整批修改回归。"""

import os
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/large-ledger'
COUNT = 10_000
ACCOUNT_ID = 810_001
SOURCE_CATEGORY_ID = 820_001
TARGET_CATEGORY_ID = 820_002


def seed_large_ledger(page) -> None:
    page.evaluate(
        """async ({count, accountId, sourceCategoryId, targetCategoryId}) => {
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const transaction = database.transaction(['entries', 'accounts', 'categories'], 'readwrite');
          const entries = transaction.objectStore('entries');
          const accounts = transaction.objectStore('accounts');
          const categories = transaction.objectStore('categories');
          entries.clear();
          accounts.clear();
          categories.clear();
          const createdAt = Date.now();
          accounts.put({
            id: accountId, name: '虚构可靠性账户', group: 'cash', balance: -50500000,
            hidden: false, countInNetWorth: true, creditReminderEnabled: true, sortOrder: 1,
            createdAt, updatedAt: createdAt,
          });
          categories.put({
            id: sourceCategoryId, name: '虚构可靠性原分类', icon: 'ic-bowl', kind: 'expense',
            sortOrder: 1, createdAt, updatedAt: createdAt,
          });
          categories.put({
            id: targetCategoryId, name: '虚构可靠性目标分类', icon: 'ic-bus', kind: 'expense',
            sortOrder: 2, createdAt, updatedAt: createdAt,
          });
          const occurredAt = new Date(2026, 8, 10, 12, 0).getTime();
          for (let index = 0; index < count; index++) {
            entries.put({
              id: 900000 + index,
              type: 'expense', amount: (index % 100 + 1) * 100,
              occurredAt: occurredAt + index,
              categoryId: sourceCategoryId, accountId,
              note: `虚构可靠性账单 ${index + 1}`,
              reimburseStatus: 'none', deletedAt: 0, createdAt, updatedAt: createdAt,
            });
          }
          await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('seed aborted'));
          });
          database.close();
        }""",
        {
            'count': COUNT,
            'accountId': ACCOUNT_ID,
            'sourceCategoryId': SOURCE_CATEGORY_ID,
            'targetCategoryId': TARGET_CATEGORY_ID,
        },
    )


def category_count(page, category_id: int) -> int:
    return page.evaluate(
        """async categoryId => {
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const transaction = database.transaction('entries', 'readonly');
          const request = transaction.objectStore('entries').index('categoryId').count(categoryId);
          const count = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          database.close();
          return count;
        }""",
        category_id,
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
        page = context.new_page()
        page.set_default_timeout(20_000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(URL)
        page.wait_for_selector('#fab')
        seed_large_ledger(page)

        page.click('#btn-search')
        page.wait_for_selector('#sp-search.open')
        started_at = time.monotonic()
        page.fill('#sr-input', '虚构可靠性账单')
        page.wait_for_selector('#sr-load-more')
        search_elapsed = time.monotonic() - started_at
        assert page.locator('#sr-results [data-eid]').count() == 100
        assert '100 / 10000 笔' in page.locator('#sr-load-more').inner_text()
        assert search_elapsed < 10, f'一万笔筛选耗时过长：{search_elapsed:.2f}s'
        assert page.get_attribute('#sr-results', 'aria-busy') == 'false'
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')

        page.click('#sr-batch')
        page.wait_for_selector('.sr-batch-scope')
        assert '已载入 10000 笔' in page.locator('.sr-batch-scope').inner_text()
        assert '已选 10000 / 10000 笔' in page.locator('#sr-batch-count').inner_text()
        assert page.locator('#sr-results [data-eid]').count() == 100

        page.click('[data-batch-act="category"]')
        picker = page.locator(
            f'#sheet [data-pick="{TARGET_CATEGORY_ID}"]',
        )
        picker.wait_for()
        picker.click()
        page.wait_for_selector('#dialog-scrim.show')
        assert '可处理 10000 笔' in page.locator('#dialog-scrim').inner_text()
        batch_started_at = time.monotonic()
        page.click('#dialog-scrim [data-act="ok"]')
        page.wait_for_selector('#sr-batch-bar[aria-busy="true"]')
        assert '正在处理 10000 笔' in page.locator('#sr-batch-count').inner_text()
        page.wait_for_selector('#toast.show', timeout=20_000)
        assert '已改分类 10000 笔' in page.locator('#toast').inner_text()
        commit_toast_elapsed = time.monotonic() - batch_started_at
        page.wait_for_function("document.querySelector('#sr-results')?.getAttribute('aria-busy') === 'false'")
        batch_elapsed = time.monotonic() - batch_started_at
        target_count = category_count(page, TARGET_CATEGORY_ID)
        source_count = category_count(page, SOURCE_CATEGORY_ID)
        print('LARGE_LEDGER_METRICS', {
            'search_seconds': round(search_elapsed, 3),
            'confirm_to_success_toast_seconds': round(commit_toast_elapsed, 3),
            'toast_to_results_ready_seconds': round(batch_elapsed - commit_toast_elapsed, 3),
            'batch_total_seconds': round(batch_elapsed, 3),
            'target_count': target_count, 'source_count': source_count,
            'page_errors': errors,
            'dom': page.evaluate('''() => ({
              home_inert: document.querySelector('#page-home')?.inert,
              home_rows: document.querySelectorAll('#hm-days [data-entry-row]').length,
              search_rows: document.querySelectorAll('#sr-results [data-eid]').length,
              search_busy: document.querySelector('#sr-results')?.getAttribute('aria-busy'),
            })'''),
        }, flush=True)
        page.screenshot(path=str(OUT / 'search-and-batch-390.png'), full_page=True)
        if batch_elapsed >= 15:
            print('FRESH_WRITE_QUEUE_DIAGNOSTIC', page.evaluate('''async ({ source, target }) => {
              const open = (name, upgrade) => new Promise((resolve, reject) => {
                const request = indexedDB.open(name, 1);
                request.onupgradeneeded = () => upgrade?.(request.result);
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
              });
              const sourceDb = await new Promise((resolve, reject) => {
                const request = indexedDB.open('GleamDB');
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
              });
              const sourceStore = sourceDb.transaction('entries').objectStore('entries');
              const indexes = Array.from(sourceStore.indexNames).map(name => {
                const index = sourceStore.index(name);
                return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
              });
              const rows = await new Promise((resolve, reject) => {
                const request = sourceStore.getAll();
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
              });
              sourceDb.close();
              const results = [];
              for (const chunkSize of [500, 100, 50]) {
                const name = `GleamSyntheticWriteBenchmark-${chunkSize}-${Date.now()}`;
                const db = await open(name, db => {
                  const store = db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
                  for (const index of indexes) store.createIndex(index.name, index.keyPath, index);
                  for (const name of ['accounts', 'entryTags', 'categories', 'tags']) db.createObjectStore(name, { keyPath: 'id' });
                });
                const seed = db.transaction('entries', 'readwrite');
                const seeded = new Promise((resolve, reject) => { seed.oncomplete = resolve; seed.onabort = () => reject(seed.error); });
                for (const row of rows) seed.objectStore('entries').put({ ...row, categoryId: source });
                await seeded;
                const ordered = [...rows].sort((a, b) => b.id - a.id);
                const start = performance.now();
                const tx = db.transaction(['entries', 'accounts', 'entryTags', 'categories', 'tags'], 'readwrite');
                const complete = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
                for (let offset = 0; offset < ordered.length; offset += chunkSize) {
                  await new Promise((resolve, reject) => {
                    let last;
                    for (const row of ordered.slice(offset, offset + chunkSize)) last = tx.objectStore('entries').put({ ...row, categoryId: target });
                    last.addEventListener('success', resolve, { once: true });
                    last.addEventListener('error', () => reject(last.error), { once: true });
                  });
                }
                await complete;
                results.push({ chunkSize, count: ordered.length, milliseconds: performance.now() - start });
                db.close();
                await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
              }
              return results;
            }''', {'source': SOURCE_CATEGORY_ID, 'target': TARGET_CATEGORY_ID}), flush=True)
        assert batch_elapsed < 15, f'一万笔批量改分类耗时过长：{batch_elapsed:.2f}s'
        assert target_count == COUNT
        assert source_count == 0
        assert not errors, errors
        print(
            f'PASS 10000 entries: search {search_elapsed:.2f}s, batch {batch_elapsed:.2f}s, '
            '100-row page and complete transaction',
            flush=True,
        )
        context.close()
        browser.close()


if __name__ == '__main__':
    main()
