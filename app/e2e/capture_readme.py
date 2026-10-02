"""Capture the real app with isolated fictional data; never edit screenshot pixels.

Run after the production build. run_all.py supplies its existing preview server.
Outputs stay in .tmp until the images have been visually reviewed for publication.
AI responses are local fixtures, not calls to an external model.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUTPUT = Path(__file__).parents[2] / '.tmp/tests/e2e/readme'
DEMO_TIME = datetime(2026, 10, 2, 4, 0, tzinfo=timezone.utc)
AI_ORIGIN = 'https://showcase.invalid'


def seed(page):
    """Only populate this new browser context's synthetic IndexedDB."""
    page.evaluate('''async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const names = ['accounts', 'categories', 'entries', 'budgets', 'lifeNotes',
        'habits', 'habitChecks', 'settings'];
      const tx = db.transaction(names, 'readwrite');
      for (const name of names) tx.objectStore(name).clear();
      const stamp = {createdAt: Date.now(), updatedAt: Date.now()};
      const put = (table, rows) => rows.forEach(row => tx.objectStore(table).put({...stamp, ...row}));
      const at = (day, time) => new Date(`2026-${day}T${time}:00+08:00`).getTime();
      const accounts = [
        {id: 1, name: '日常钱包', group: 'cash', balance: 20000},
        {id: 2, name: '工资卡', group: 'debit', balance: 1500000},
        {id: 3, name: '小林 · 应收', group: 'receivable', balance: 0},
      ].map(a => ({...a, hidden: false, countInNetWorth: true, sortOrder: a.id}));
      put('categories', [
        {id: 1, name: '餐饮', kind: 'expense', icon: 'ic-bowl', sortOrder: 1},
        {id: 2, name: '午餐', kind: 'expense', parentId: 1, icon: 'ic-bowl', sortOrder: 2},
        {id: 3, name: '咖啡', kind: 'expense', parentId: 1, icon: 'ic-cup', sortOrder: 3},
        {id: 4, name: '居住', kind: 'expense', icon: 'ic-home', sortOrder: 4},
        {id: 5, name: '日用', kind: 'expense', icon: 'ic-cart', sortOrder: 5},
        {id: 6, name: '交通', kind: 'expense', icon: 'ic-bus', sortOrder: 6},
        {id: 7, name: '工资', kind: 'income', icon: 'ic-coin', sortOrder: 7},
      ]);
      const entries = [
        {id: 1, type: 'income', amount: 1200000, categoryId: 7, accountId: 2, occurredAt: at('10-01', '09:00')},
        {id: 2, type: 'expense', amount: 230000, categoryId: 4, accountId: 2, occurredAt: at('10-01', '09:30'), note: '十月房租'},
        {id: 3, type: 'expense', amount: 12600, categoryId: 5, accountId: 2, occurredAt: at('10-01', '17:00'), note: '补齐日用品'},
        {id: 4, type: 'expense', amount: 600, categoryId: 6, accountId: 2, occurredAt: at('10-01', '18:00')},
        {id: 5, type: 'expense', amount: 1800, categoryId: 3, accountId: 1, occurredAt: at('10-02', '09:20')},
        {id: 6, type: 'expense', amount: 3200, categoryId: 2, accountId: 1, occurredAt: at('10-02', '11:40')},
        {id: 7, type: 'loan', loanKind: 'lend', amount: 30000, fromAccountId: 2, toAccountId: 3, occurredAt: at('10-01', '19:00')},
      ];
      for (const entry of entries) {
        const delta = (id, amount) => accounts.find(a => a.id === id).balance += amount;
        if (entry.accountId) delta(entry.accountId, entry.type === 'income' ? entry.amount : -entry.amount);
        if (entry.fromAccountId) delta(entry.fromAccountId, -entry.amount);
        if (entry.toAccountId) delta(entry.toAccountId, entry.amount);
      }
      put('accounts', accounts);
      put('entries', entries.map(e => ({deletedAt: 0, reimburseStatus: 'none', ...e})));
      put('budgets', [{id: 1, month: '2026-10', totalLimit: 600000, autoRenew: false}]);
      put('lifeNotes', [
        {id: 101, kind: 'diary', title: '午间的小公园', body: '吃过午饭，在树荫下坐了一会儿。风吹过来，整个人都轻松了。', mood: '平静', tags: ['散步'], occurredAt: at('10-02', '11:55'), deletedAt: 0},
        {id: 102, kind: 'diary', title: '给阳台添一点绿', body: '把薄荷放到窗边，等下一次泡茶时摘两片。', occurredAt: at('10-01', '20:00'), deletedAt: 0},
        {id: 201, kind: 'diary', title: '慢慢走回家', body: '傍晚换了一条回家的路，看见街角的桂花开了。', occurredAt: at('09-23', '18:30'), deletedAt: 0},
        {id: 202, kind: 'diary', title: '周末的一杯茶', body: '在阳台读了几页书，茶凉了也没有急着起身。', occurredAt: at('09-26', '15:00'), deletedAt: 0},
      ]);
      put('habits', [{id: 1, name: '晚饭后散步', sortOrder: 1}]);
      put('habitChecks', ['09-29', '09-30', '10-01'].map((day, i) => ({id: i + 1, habitId: 1, day: `2026-${day}`, checkAt: at(day, '19:30')})));
      for (const [key, value] of [['ai.baseUrl', 'https://showcase.invalid/v1'],
          ['ai.model', 'showcase-fixture'], ['life.aiEnabled', true]]) {
        tx.objectStore('settings').put({key, value});
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      db.close();
      sessionStorage.setItem('gleam-secret:ai.apiKey', 'synthetic-test-key');
    }''')
    page.reload()
    page.locator('#hm-days [data-entry-row="6"]').wait_for()


def capture(page, name, width, selector):
    page.locator(selector).wait_for(state='visible')
    page.locator('#toast.show').wait_for(state='hidden')
    page.evaluate('document.activeElement?.blur()')
    page.wait_for_timeout(400)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), name
    assert page.locator(selector).evaluate('el => el.scrollWidth <= el.clientWidth + 1'), name
    destination = OUTPUT / str(width)
    destination.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(destination / f'{name}-demo.png'), animations='disabled')


def run(browser, width):
    context = browser.new_context(viewport={'width': width, 'height': 844},
        timezone_id='Asia/Shanghai', locale='zh-CN', service_workers='block', reduced_motion='reduce')
    errors, blocked = [], []
    origin = urlsplit(URL)

    def route_request(route):
        target = urlsplit(route.request.url)
        if (target.scheme, target.netloc) == (origin.scheme, origin.netloc):
            route.continue_()
        elif route.request.url.startswith(AI_ORIGIN + '/'):
            payload = route.request.post_data_json
            if '拾光周刊' in payload['messages'][0]['content']:
                reply = {'title': '把日子过慢一点', 'blocks': [
                    {'noteId': 201, 'text': '换一条回家的路，才发现街角的桂花已经开了。'},
                    {'noteId': 202, 'text': '周末留给一本书和一杯茶，不赶时间，也很好。'},
                ]}
                route.fulfill(json={'choices': [{'message': {'content': json.dumps(reply, ensure_ascii=False)}}]})
            else:
                answer = '**可以试试这三个小安排：**\n\n1. 换一条回家的路，走过平时没留意的小巷。\n2. 带一本薄书，在公园坐二十分钟。\n3. 买一点喜欢的食材，慢慢做顿晚饭。\n\n不必排满，挑一个当下想做的就好。'
                event = json.dumps({'choices': [{'delta': {'content': answer}}]}, ensure_ascii=False)
                route.fulfill(status=200, content_type='text/event-stream', body=f'data: {event}\n\ndata: [DONE]\n\n')
        else:
            blocked.append(route.request.url)
            route.abort()

    context.route('**/*', route_request)
    page = context.new_page()
    page.set_default_timeout(15_000)
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.set_fixed_time(DEMO_TIME)
    try:
        page.goto(URL)
        page.locator('#fab').wait_for()
        seed(page)
        capture(page, 'home', width, '#page-home')

        page.locator('[data-page="page-acct"]').click()
        page.locator('[data-acct="3"]').wait_for()
        capture(page, 'accounts', width, '#page-acct')

        page.locator('[data-page="page-report"]').click()
        page.locator('#report-dim [data-dimension="category"]').click()
        page.locator('#report-rank-card:not([hidden]) .rank-link').first.wait_for()
        page.locator('#page-report').evaluate('el => el.scrollTop = 0')
        expect(page.locator('#r-spend')).to_contain_text('2,482.00')
        capture(page, 'report', width, '#page-report')

        page.locator('[data-page="page-life"]').click()
        page.locator('#lf-feed [data-note="101"]').wait_for()
        capture(page, 'life', width, '#page-life')

        page.locator('[data-life-chat]').click()
        page.locator('#life-chat-input').fill('这个周末想慢一点，有什么简单的小安排？')
        page.locator('[data-life-chat-send]').click()
        page.locator('#dialog-scrim.show [data-act="ok"]').click()
        page.locator('.assistant .chat-message-text strong').wait_for()
        page.locator('[data-life-chat-stop]').wait_for(state='hidden')
        capture(page, 'chat', width, '#sp-life-chat')
        page.locator('#sp-life-chat .sub-head [data-act="back"]').click()
        page.locator('#sp-life-chat').wait_for(state='detached')

        page.locator('[data-life-edition]').click()
        expect(page.locator('[data-le-source]')).to_have_count(2)
        page.locator('[data-le-generate]').click()
        page.locator('#dialog-scrim.show [data-act="ok"]').click()
        page.locator('#le-title').wait_for()
        page.locator('[data-le-save]').click()
        page.locator('[data-le-edit]').wait_for()
        capture(page, 'weekly', width, '#sp-life-edition')
        page.locator('#sp-life-edition .sub-head [data-act="back"]').click()
        page.locator('#sp-life-edition').wait_for(state='detached')

        page.locator('#tab-home').click()
        page.locator('#fab').click()
        page.locator('#seg [data-type="loan"]').click()
        page.locator('[data-kind="lend"]').click()
        page.locator('#loan-who').click()
        page.locator('.picker-item[data-value="3"]').click()
        page.locator('.picker-mask').wait_for(state='detached')
        page.locator('#loan-acct').click()
        page.locator('.picker-item[data-value="2"]').click()
        page.locator('.picker-mask').wait_for(state='detached')
        for digit in '100':
            page.locator(f'#keypad [data-k="{digit}"]').click()
        capture(page, 'loan', width, '#sheet.open')
        assert not errors, errors
        assert not blocked, blocked
        print(f'PASS README screenshots: {width}px, 7 views, fictional data, mocked AI', flush=True)
    finally:
        context.close()


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width in (360, 390, 430, 1280):
                run(browser, width)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
