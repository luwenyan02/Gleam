"""月度账本分析：本机预览、逐次同意、范围与目的地绑定；仅虚构数据和模拟服务。"""
import json
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from test_life_ai import configure, open_life, read_rows

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-ledger-context'


def setting(page, key, value):
    page.evaluate('''([key,value]) => new Promise(resolve => {
      const r = indexedDB.open('GleamDB'); r.onsuccess = () => {
        const db = r.result, tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put({key,value}); tx.oncomplete = () => {db.close(); resolve();};
      };
    })''', [key, value])


def capture(page, name, width):
    page.wait_for_timeout(350)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    assert page.locator('#sheet').evaluate('el => el.scrollWidth <= el.clientWidth + 1')
    for button in page.locator('#sheet button').all():
        rect = button.bounding_box()
        if rect:
            assert rect['width'] >= 43 and rect['height'] >= 43
    page.screenshot(path=str(OUT / f'{name}-{width}.png'), animations='disabled')


def run(page, width):
    errors, payloads, held = [], [], []
    fail, hold = [False], [False]
    page.on('pageerror', lambda error: errors.append(str(error)))
    open_life(page)
    configure(page)
    month = page.evaluate('''async () => {
      const db = await new Promise(resolve => {const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result);});
      const tx = db.transaction(['entries','categories','settings'], 'readwrite');
      const now = new Date(), current = new Date(now.getFullYear(),now.getMonth(),1,12).getTime();
      const previous = new Date(now.getFullYear(),now.getMonth()-1,1,12).getTime();
      tx.objectStore('entries').clear();
      tx.objectStore('categories').put({id:9901,kind:'expense',name:'虚构餐饮',icon:'🍚',sortOrder:1,createdAt:1,updatedAt:1});
      tx.objectStore('settings').put({key:'reimburse.countAsIncome',value:false});
      tx.objectStore('settings').put({key:'accounting.monthStartDay',value:20});
      const base = {type:'expense',occurredAt:current,categoryId:9901,accountId:9909,reimburseStatus:'none',deletedAt:0,createdAt:1,updatedAt:1,note:'绝不上传的虚构备注',merchantId:9911};
      for (const row of [
        {id:99001,amount:12000}, {id:99002,amount:2000,refundFlag:true},
        {id:99003,amount:5000,reimburseStatus:'done',reimbursedAmount:3000,reimbursedAt:current,reimburseAccountId:9909},
        {id:99004,amount:77777,occurredAt:previous}, {id:99005,amount:88888,deletedAt:1},
        {id:99006,amount:999999,type:'transfer'}, {id:99007,amount:666666,type:'loan',loanKind:'borrow'},
        {id:99008,amount:90000,type:'income'}
      ]) tx.objectStore('entries').put({...base,...row});
      await new Promise(resolve => {tx.oncomplete = resolve;}); db.close();
      return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    }''')

    def mock(route):
        payloads.append(route.request.post_data_json)
        if hold[0]:
            held.append(route)
        elif fail[0]:
            fail[0] = False
            route.fulfill(status=500, body='private provider body must not appear')
        else:
            route.fulfill(json={'choices': [{'message': {'content': '虚构账本分析：本期净支出 120 元。'}}]})

    page.route('https://life-ai.invalid/**', mock)
    page.route('https://changed-ledger.invalid/**', mock)
    page.locator('[data-life-chat]').click()
    for removed in ('聊聊想法与日常', '不必每天来，想说的时候我都在。', 'AI 也会出错，请核实重要信息'):
        assert removed not in page.locator('#sp-life-chat').inner_text()
    page.get_by_role('button', name='分析消费', exact=True).click()
    assert page.locator('#life-chat-input').input_value() == '帮我分析一下我这个月的消费情况。'
    page.locator('[data-life-chat-send]').click()
    expect(page.locator('[data-ledger-preview]')).to_contain_text('净支出 ¥120.00')
    assert page.locator('[data-ledger-period="calendar"]').get_attribute('aria-pressed') == 'true'
    assert not page.locator('[data-ledger-income]').is_checked()
    assert '绝不上传' not in page.locator('[data-ledger-preview]').inner_text()
    assert not payloads
    capture(page, 'scope-preview', width)
    page.locator('[data-ledger-approve]').scroll_into_view_if_needed()
    capture(page, 'scope-approval', width)
    page.locator('[data-ledger-cancel]').click()
    page.locator('.life-chat-failed').wait_for()
    assert not payloads

    # Back closes only the top review; retry always asks again.
    page.locator('[data-life-chat-retry]').click()
    page.locator('[data-ledger-approve]:enabled').wait_for()
    page.go_back()
    page.locator('#sheet.open').wait_for(state='hidden')
    assert page.locator('#sp-life-chat').is_visible()
    assert not payloads
    page.locator('[data-life-chat-retry]').click()
    page.locator('[data-ledger-approve]:enabled').click()
    expect(page.locator('.assistant .chat-message-text')).to_contain_text('本期净支出 120 元')
    page.locator('[data-life-chat-stop]').wait_for(state='hidden')
    assert len(payloads) == 1
    assert len(payloads[0]['messages']) == 2
    sent = json.loads(payloads[0]['messages'][-1]['content'])
    assert sent['summary']['scope'] == {'month': month, 'period': 'calendar', 'includeIncome': False}
    assert sent['summary']['totals']['expenseFen'] == 12000
    assert 'income' not in sent['summary']
    for forbidden in ('绝不上传', 'accountId', 'merchantId', 'balance', 'ledgerGrant'):
        assert forbidden not in json.dumps(sent, ensure_ascii=False)
    drafts = read_rows(page, 'lifeDrafts')
    assert any(all(message.get('ledgerAnalysis') for message in draft['messages']) for draft in drafts if draft['key'].startswith('chat:'))

    # New scope stays local; cancel regeneration preserves the prior answer.
    page.locator('[data-chat-regenerate]').click()
    page.locator('[data-ledger-prev]').click()
    expect(page.locator('[data-ledger-preview]')).to_contain_text('净支出 ¥777.77')
    assert len(payloads) == 1
    page.locator('[data-ledger-cancel]').click()
    assert page.locator('.assistant').count() == 1
    page.locator('[data-life-chat-stop]').wait_for(state='hidden')

    # Changing the destination after review never sends to either service silently.
    page.locator('[data-chat-regenerate]').click()
    page.locator('[data-ledger-approve]:enabled').wait_for()
    setting(page, 'ai.baseUrl', 'https://changed-ledger.invalid/v1')
    page.locator('[data-ledger-approve]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('配置已变化')
    assert len(payloads) == 1
    page.locator('[data-life-chat-retry]').click()
    expect(page.locator('.life-ledger-destination')).to_contain_text('changed-ledger.invalid')
    page.locator('[data-ledger-approve]:enabled').click()
    page.locator('[data-life-chat-stop]').wait_for(state='hidden')
    assert len(payloads) == 2 and page.locator('.assistant').count() == 1

    # History may contain financial analysis: every subsequent transmission asks again.
    page.locator('#life-chat-input').fill('给我一个简短建议。')
    page.locator('[data-life-chat-send]').click()
    expect(page.locator('#dialog-scrim.show')).to_contain_text('先前的账本分析')
    assert len(payloads) == 2
    page.locator('#dialog-scrim [data-act="cancel"]').click()
    page.locator('[data-life-chat-retry]').click()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('[data-life-chat-stop]').wait_for(state='hidden')
    assert len(payloads) == 3
    page.reload()
    page.locator('#fab').wait_for()
    page.locator('[data-page="page-life"]').click()
    page.locator('[data-life-chat]').click()
    page.locator('#life-chat-input').fill('再简短一点。')
    page.locator('[data-life-chat-send]').click()
    expect(page.locator('#dialog-scrim.show')).to_contain_text('先前的账本分析')
    page.locator('#dialog-scrim [data-act="cancel"]').click()
    assert len(payloads) == 3

    # Failure and stop do not reuse a grant; an empty month is answered locally.
    page.locator('[data-chat-start]').click()
    page.locator('.chat-welcome').wait_for()
    expect(page.locator('#life-chat-input')).to_have_value('')
    page.locator('#life-chat-input').fill('帮我分析这个月的消费')
    fail[0] = True
    page.locator('[data-life-chat-send]').click()
    page.locator('[data-ledger-approve]:enabled').click()
    expect(page.locator('#life-chat-status')).to_contain_text('暂时不可用')
    assert len(payloads) == 4
    page.locator('[data-life-chat-retry]').click()
    page.locator('[data-ledger-approve]:enabled').wait_for()
    assert len(payloads) == 4
    hold[0] = True
    page.locator('[data-ledger-approve]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('正在想')
    page.wait_for_function('document.querySelector("[data-life-chat-stop]").hidden === false')
    page.locator('[data-life-chat-stop]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('已停止')
    for route in held:
        try:
            route.abort()
        except Exception:
            pass
    hold[0] = False
    count = len(payloads)
    page.locator('[data-life-chat-retry]').click()
    page.locator('[data-ledger-next]').click()
    expect(page.locator('[data-ledger-error]')).to_contain_text('暂无账单')
    assert page.locator('[data-ledger-approve]').is_disabled()
    assert len(payloads) == count
    capture(page, 'empty-month', width)
    page.locator('[data-ledger-close]').click()
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1280):
            context = browser.new_context(viewport={'width': width, 'height': 844}, reduced_motion='reduce')
            page = context.new_page()
            try:
                run(page, width)
            except Exception:
                page.screenshot(path=str(OUT / f'failed-{width}.png'), animations='disabled')
                raise
            finally:
                context.close()
            print(f'PASS chat ledger context {width}', flush=True)
        browser.close()
