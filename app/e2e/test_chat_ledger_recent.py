"""近期消费自然语言查询：跨月虚构账本、发送预览及本机核对；零真实模型请求。"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from test_chat_ledger_context import capture
from test_life_ai import configure, open_life, read_rows
from test_stats_safety import seed

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-ledger-recent'
QUESTION = '帮我总结和分一下近1个月的消费记录'
PRIVATE_NOTE = '禁止外发的虚构消费备注'


def shot(page, name, width):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.screenshot(path=str(OUT / f'{name}-{width}.png'), animations='disabled')


def run(page, width):
    errors, payloads = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.set_fixed_time(datetime(2026, 10, 12, 4, tzinfo=timezone.utc))
    open_life(page)
    bounds = page.evaluate('''() => ({
      from: new Date(2026,8,13).getTime(), to: new Date(2026,9,13).getTime(),
      reimbursed: new Date(2026,10,1).getTime(), october: new Date(2026,9,1,12).getTime()
    })''')
    base = {'type': 'expense', 'categoryId': 1, 'accountId': 1,
            'occurredAt': bounds['october'], 'amount': 10000, 'note': PRIVATE_NOTE}
    entries = [{**base, **patch} for patch in [
        {'id': 1, 'occurredAt': bounds['from']},
        {'id': 2, 'amount': 5000, 'reimburseStatus': 'done', 'reimbursedAmount': 3000,
         'reimbursedAt': bounds['reimbursed'], 'reimburseAccountId': 1},
        {'id': 3, 'amount': 2000, 'refundFlag': True},
        {'id': 4, 'amount': 4000, 'occurredAt': bounds['to'] - 1},
        {'id': 5, 'amount': 88888, 'occurredAt': bounds['from'] - 1},
        {'id': 6, 'amount': 99999, 'occurredAt': bounds['to']},
        {'id': 7, 'amount': 90000, 'type': 'income'},
        {'id': 8, 'amount': 70000, 'type': 'transfer', 'fromAccountId': 1, 'toAccountId': 2},
        {'id': 9, 'amount': 60000, 'type': 'loan', 'fromAccountId': 1, 'toAccountId': 2},
        {'id': 10, 'amount': 77777, 'deletedAt': 1},
    ]]
    seed(page, entries)
    configure(page)
    original = read_rows(page, 'entries')
    page.locator('[data-page="page-life"]').click()

    def mock(route):
        payloads.append(route.request.post_data_json)
        route.fulfill(json={'choices': [{'message': {'content': '近30天已记账净支出 140 元，可查看下方本机数据。'}}]})

    page.route('https://life-ai.invalid/**', mock)
    page.locator('[data-life-chat]').click()
    page.locator('#life-chat-input').fill('我最近一个月消费很多，有点担心')
    page.locator('[data-life-chat-send]').click()
    expect(page.locator('#dialog-scrim.show')).to_be_visible()
    assert page.locator('[data-ledger-preview]').count() == 0
    assert not payloads
    page.locator('#dialog-scrim [data-act="cancel"]').click()
    page.locator('[data-chat-start]').click()
    page.locator('.chat-welcome').wait_for()
    expect(page.locator('#life-chat-input')).to_have_value('')

    page.locator('#life-chat-input').fill(QUESTION)
    page.locator('[data-life-chat-send]').click()
    expect(page.locator('[data-ledger-period="recent"]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('[data-ledger-preview]')).to_contain_text('2026/9/13 – 2026/10/12')
    expect(page.locator('[data-ledger-preview]')).to_contain_text('净支出 ¥140.00')
    expect(page.locator('.life-ledger-month')).to_be_hidden()
    expect(page.locator('.life-ledger-modes')).to_be_hidden()
    page.locator('[data-ledger-approve]:enabled').wait_for()
    assert not payloads
    capture(page, 'recent-preview', width)
    shot(page, 'preview', width)
    page.locator('[data-ledger-approve]').scroll_into_view_if_needed()
    for button in page.locator('.life-ledger-actions button').all():
        assert button.evaluate('''el => {
          const rect = el.getBoundingClientRect(), scroll = el.closest('.sheet-scroll').getBoundingClientRect();
          return rect.top >= scroll.top - 1 && rect.bottom <= scroll.bottom + 1;
        }'''), '发送确认按钮必须可以完整滚动到可见区域'
    shot(page, 'approval', width)

    # Month and rolling range are visibly different, and nothing is sent by switching.
    page.locator('[data-ledger-period="calendar"]').click()
    expect(page.locator('.life-ledger-month')).to_be_visible()
    expect(page.locator('[data-ledger-preview]')).to_contain_text('净支出 ¥1,039.99')
    page.locator('[data-ledger-period="recent"]').click()
    expect(page.locator('[data-ledger-preview]')).to_contain_text('净支出 ¥140.00')
    page.locator('[data-ledger-income]').check()
    expect(page.locator('[data-ledger-preview]')).to_contain_text('收入 1 笔，合计 ¥900.00')
    page.locator('[data-ledger-income]').uncheck()
    page.locator('[data-ledger-approve]:enabled').wait_for()
    assert not payloads
    page.locator('[data-ledger-cancel]').click()
    page.locator('.life-chat-failed').wait_for()
    page.locator('[data-life-chat-retry]').click()
    expect(page.locator('[data-ledger-period="recent"]')).to_have_attribute('aria-pressed', 'true')
    page.locator('[data-ledger-approve]:enabled').click()
    expect(page.locator('[data-ledger-result]')).to_have_count(1)
    page.locator('[data-life-chat-stop]').wait_for(state='hidden')
    assert len(payloads) == 1
    assert len(payloads[0]['messages']) == 2
    sent = json.loads(payloads[0]['messages'][-1]['content'])
    assert sent['question'] == QUESTION
    assert sent['summary']['scope'] == {'month': '2026-10', 'period': 'recent', 'endDate': '2026-10-12', 'includeIncome': False}
    assert sent['summary']['range']['from'] == bounds['from'] and sent['summary']['range']['to'] == bounds['to']
    assert sent['summary']['totals']['expenseFen'] == 14000
    assert sent['summary']['totals']['expenseCount'] == 3
    assert sent['summary']['totals']['refundCount'] == 1
    assert sent['summary']['categories'] == [{'name': '虚构餐饮', 'expenseFen': 14000, 'count': 4}]
    assert 'income' not in sent['summary']
    for forbidden in (PRIVATE_NOTE, 'accountId', 'merchantId', 'entryId', 'ledgerGrant', 'items', '我最近一个月消费很多'):
        assert forbidden not in json.dumps(sent, ensure_ascii=False)
    assert 'scope.period 为 recent' in payloads[0]['messages'][0]['content']
    result = page.locator('[data-ledger-result]').last
    expect(result.locator('.life-ledger-result-scope')).to_have_text('近30天 · 分类构成')
    shot(page, 'result', width)

    result.get_by_role('button', name='核对 近30天 支出明细', exact=True).click()
    expect(page.locator('[data-ledger-evidence-summary]')).to_contain_text('净支出 ¥140.00')
    ids = page.locator('[data-ledger-entry]').evaluate_all('els => els.map(el => Number(el.dataset.ledgerEntry)).sort()')
    assert ids == [1, 2, 3, 4], ids
    assert len(payloads) == 1
    shot(page, 'evidence', width)
    page.locator('[data-ledger-evidence-close]').click()
    expect(result.get_by_role('button', name='核对 近30天 支出明细', exact=True)).to_be_focused()
    result.locator('.life-ledger-categories summary').click()
    result.get_by_role('button', name='核对 虚构餐饮分类明细', exact=True).click()
    expect(page.locator('[data-ledger-entry]')).to_have_count(4)
    page.locator('[data-ledger-evidence-close]').click()
    assert read_rows(page, 'entries') == original

    # Follow-ups deliberately switch to a named monthly range with fresh confirmation.
    result.get_by_role('button', name='查看本月', exact=True).click()
    expect(page.locator('[data-ledger-period="calendar"]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('[data-ledger-preview]')).to_contain_text('净支出 ¥1,039.99')
    assert len(payloads) == 1
    page.locator('[data-ledger-cancel]').click()

    # A new query gets another review; mutation before approval invalidates the snapshot.
    page.locator('#life-chat-input').fill(QUESTION)
    page.locator('[data-life-chat-send]').click()
    page.locator('[data-ledger-approve]:enabled').wait_for()
    page.evaluate('''() => new Promise(resolve => {
      const r = indexedDB.open('GleamDB'); r.onsuccess = () => {
        const db = r.result, tx = db.transaction('entries', 'readwrite'), store = tx.objectStore('entries');
        const item = store.get(1); item.onsuccess = () => store.put({...item.result, amount: 10100});
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    })''')
    page.locator('[data-ledger-approve]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('重新确认')
    assert len(payloads) == 1
    page.locator('[data-life-chat-retry]').click()
    expect(page.locator('[data-ledger-preview]')).to_contain_text('净支出 ¥141.00')
    page.locator('[data-ledger-cancel]').click()

    # Empty ranges stay local, so the model cannot substitute made-up data.
    page.evaluate('''() => new Promise(resolve => {
      const r = indexedDB.open('GleamDB'); r.onsuccess = () => {
        const db = r.result, tx = db.transaction('entries', 'readwrite');
        tx.objectStore('entries').clear(); tx.oncomplete = () => {db.close(); resolve();};
      };
    })''')
    page.locator('[data-chat-start]').click()
    page.locator('.chat-welcome').wait_for()
    expect(page.locator('#life-chat-input')).to_have_value('')
    page.locator('#life-chat-input').fill(QUESTION)
    page.locator('[data-life-chat-send]').click()
    expect(page.locator('[data-ledger-error]')).to_contain_text('暂无账单')
    assert page.locator('[data-ledger-approve]').is_disabled()
    assert len(payloads) == 1
    page.locator('[data-ledger-cancel]').click()
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('GLEAM_E2E_CHROMIUM'))
        for width in (360, 390, 430, 1280):
            context = browser.new_context(viewport={'width': width, 'height': 844},
                                          timezone_id='Asia/Shanghai', reduced_motion='reduce', service_workers='block')
            page = context.new_page()
            try:
                run(page, width)
            except Exception:
                shot(page, 'failed', width)
                raise
            finally:
                context.close()
            print(f'PASS recent ledger query, cross-month totals, consent and evidence {width}', flush=True)
        browser.close()
