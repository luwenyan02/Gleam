"""周期账待确认项双击安全回归；仅使用独立浏览器上下文与虚构数据。"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

from test_acceptance_fixes import seed


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
SHOTS = Path(os.environ.get(
    'GLEAM_E2E_SCREENSHOTS',
    Path(__file__).parents[2] / '.tmp/tests/e2e/screenshots',
))
SHOTS.mkdir(parents=True, exist_ok=True)


def recurring_double_click(page) -> None:
    seed(page, count=0)
    due_at = page.evaluate('''async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const dueAt = Date.now() - 60_000;
      await new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put({
        key: 'recurring.pendingConfirms',
        value: [{
          ruleId: 999,
          name: '虚构双击周期账',
          amount: 1234,
          dueAt,
          accountId: 1,
          categoryId: 2,
        }],
          updatedAt: Date.now(),
        });
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return dueAt;
    }''')
    page.reload()
    page.locator('#fab').wait_for()
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-recurring"]').click()
    page.locator('#sp-recurring [data-act="pending"]').click()
    button = page.locator('[data-book="0"]')
    button.wait_for()

    locked_immediately = button.evaluate('''button => {
      button.click();
      const locked = button.disabled;
      button.click();
      return locked;
    }''')
    page.wait_for_timeout(450)

    state = page.evaluate('''async ({ dueAt }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(['entries', 'accounts', 'settings']);
      const read = (store) => new Promise((resolve, reject) => {
        const request = tx.objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [entries, accounts, settings] = await Promise.all([
        read('entries'), read('accounts'), read('settings'),
      ]);
      db.close();
      const account = accounts.find((row) => row.id === 1);
      const setting = settings.find((row) => row.key === 'recurring.pendingConfirms');
      return { entries, balance: account?.balance, pending: setting?.value ?? [] };
    }''', {'dueAt': due_at})
    page.screenshot(path=str(SHOTS / 'recurring-double-click.png'))

    assert locked_immediately, '首次入账点击后未同步锁定入账按钮'
    assert len(state['entries']) == 1, '同一期双击产生了重复账单'
    assert state['entries'][0]['amount'] == 1234
    assert state['balance'] == -1234
    assert state['pending'] == []


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width in (360, 390, 430, 1024):
                context = browser.new_context(
                    viewport={'width': width, 'height': 844},
                    service_workers='block',
                )
                page = context.new_page()
                page.set_default_timeout(7000)
                try:
                    page.goto(URL)
                    page.wait_for_load_state('networkidle')
                    page.locator('#fab').wait_for()
                    recurring_double_click(page)
                    print(f'PASS recurring_double_click {width}', flush=True)
                finally:
                    context.close()
        finally:
            browser.close()
