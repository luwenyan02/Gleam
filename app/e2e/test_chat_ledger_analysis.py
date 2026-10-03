"""可核对的账本分析：真实浏览器、虚构账本、模拟 AI；不使用真实模型或凭据。"""
import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from test_chat_ledger_context import setting
from test_entry_receipts import image
from test_life_ai import configure, open_life, read_rows

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-ledger-analysis'
MONTHS = [f'2026-{month:02d}' for month in range(1, 7)]
NETS = [15000, 20000, 25000, 30000, 39000, 44000]
JUNE_EXPENSES = {'91601', '91602', '91604'}
MAY_REIMBURSED = '91505'
PRIVATE_NOTE = 'RAW_LEDGER_NOTE_MUST_STAY_LOCAL'
PRIVATE_CHAT = 'PRIOR_CHAT_MUST_STAY_LOCAL'
DRAFT = '这段尚未发送的文字必须保留'
FOLLOWUP_LABELS = {'month':'查看单月','compare':'对比上月','trend':'近6个月趋势'}
LEDGER_STORES = ['entries', 'accounts', 'categories', 'merchants', 'tags', 'entryTags', 'entryAttachments', 'attachments']


def seed(page):
    """固定日期覆盖退款、跨月报销、已删除账单、转账和借贷。"""
    page.evaluate('''async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction(['entries','accounts','categories','settings'], 'readwrite');
      tx.objectStore('entries').clear();
      const base = {type:'expense',categoryId:99101,accountId:99109,reimburseStatus:'none',deletedAt:0,createdAt:1,updatedAt:1,
        note:'RAW_LEDGER_NOTE_MUST_STAY_LOCAL',merchantId:99111};
      for (const category of [
        {id:99101,kind:'expense',name:'虚构餐饮',icon:'🍚',sortOrder:1},
        {id:99102,kind:'expense',name:'虚构交通',icon:'🚲',sortOrder:2},
        {id:99103,kind:'income',name:'虚构工资',icon:'💼',sortOrder:3}
      ]) tx.objectStore('categories').put({...category,createdAt:1,updatedAt:1});
      tx.objectStore('accounts').put({id:99109,name:'RAW_ACCOUNT_NAME_MUST_STAY_LOCAL',type:'cash',balance:98765432,initialBalance:98765432,createdAt:1,updatedAt:1,deletedAt:0});
      tx.objectStore('settings').put({key:'reimburse.countAsIncome',value:false});
      tx.objectStore('settings').put({key:'accounting.monthStartDay',value:20});
      [10000,15000,20000,25000,30000,40000].forEach((amount,index) => {
        const month = index + 1, occurredAt = new Date(2026,index,10,12).getTime(), id = 91000 + month * 100;
        for (const row of [
          {id:id+1,amount}, {id:id+2,amount:5000,categoryId:99102},
          {id:id+3,amount:80000,type:'income',categoryId:99103}
        ]) tx.objectStore('entries').put({...base,occurredAt,...row});
      });
      for (const row of [
        {id:91604,amount:1000,refundFlag:true,occurredAt:new Date(2026,5,12,12).getTime()},
        {id:91505,amount:10000,occurredAt:new Date(2026,4,10,12).getTime(),reimburseStatus:'done',reimbursedAmount:6000,reimbursedAt:new Date(2026,5,15,12).getTime(),reimburseAccountId:99109},
        {id:91606,amount:777777,deletedAt:Date.now()}, {id:91607,amount:888888,type:'transfer'},
        {id:91608,amount:999999,type:'loan',loanKind:'borrow'}
      ]) tx.objectStore('entries').put({...base,occurredAt:new Date(2026,5,10,12).getTime(),...row});
      await new Promise((resolve,reject) => {tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);}); db.close();
    }''')
    watch_writes(page)


def watch_writes(page):
    # UI flows may persist their chat draft, but must not mutate ledger data.
    page.evaluate('''stores => {
      window.__ledgerWrites = [];
      if (window.__ledgerWriteWatch) return;
      window.__ledgerWriteWatch = true;
      for (const name of ['put','add','delete','clear']) {
        const original = IDBObjectStore.prototype[name];
        IDBObjectStore.prototype[name] = function(...args) {
          if (stores.includes(this.name) && !window.__ledgerFixtureWrite) window.__ledgerWrites.push({store:this.name,operation:name});
          return original.apply(this,args);
        };
      }
    }''', LEDGER_STORES)


def mutate_entry(page, entry_id, values):
    """模拟用户在另一处修改虚构账本，不计入被测 UI 的写入。"""
    page.evaluate('''async ([id,values]) => {
      window.__ledgerFixtureWrite = true;
      try {
        const db = await new Promise(resolve => {const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result);});
        const tx=db.transaction('entries','readwrite'), store=tx.objectStore('entries'), request=store.get(id);
        request.onsuccess=()=>store.put({...request.result,...values});
        await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
      } finally {window.__ledgerFixtureWrite = false;}
    }''', [entry_id, values])


def ledger_snapshot(page):
    return {name: read_rows(page, name) for name in LEDGER_STORES}


def assert_read_only(page, snapshot):
    assert page.evaluate('window.__ledgerWrites') == [], '账本分析和核对入口不得写账'
    actual = ledger_snapshot(page)
    assert actual == snapshot, {name: {'before':snapshot[name],'after':actual[name]} for name in LEDGER_STORES if actual[name] != snapshot[name]}


def capture(page, name, width, selector):
    page.wait_for_timeout(350)
    target = page.locator(selector)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), name
    assert target.evaluate('el => el.scrollWidth <= el.clientWidth + 1'), name
    tiny = target.locator('button').evaluate_all('''buttons => buttons.filter(button => {
      const r=button.getBoundingClientRect();return r.width>0 && r.height>0 && (r.width<43.9 || r.height<43.9);
    }).map(button=>({text:button.textContent,width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}))''')
    assert not tiny, (name, tiny)
    page.screenshot(path=str(OUT / f'{name}-{width}.png'), animations='disabled')


def ready(page, kind=None):
    page.locator('[data-ledger-approve]:enabled').wait_for()
    if kind:
        expect(page.locator(f'[data-ledger-analysis="{kind}"]')).to_have_attribute('aria-pressed', 'true')


def idle(page):
    page.locator('[data-life-chat-stop]').wait_for(state='hidden')


def result(page):
    return page.locator('[data-ledger-result]').last


def followups(page, expected):
    actions = result(page).locator('[data-ledger-followup]')
    expect(actions).to_have_count(2)
    assert set(actions.all_text_contents()) == {FOLLOWUP_LABELS[kind] for kind in expected}


def choose_followup(page, kind):
    result(page).locator('[data-ledger-followup]').filter(has_text=FOLLOWUP_LABELS[kind]).click()


def summary(payload):
    assert len(payload['messages']) == 2, '账本请求必须排除历史聊天'
    data = json.loads(payload['messages'][-1]['content'])
    text = json.dumps(payload, ensure_ascii=False)
    for forbidden in (PRIVATE_NOTE, PRIVATE_CHAT, 'RAW_ACCOUNT_NAME', 'MODEL_ONLY_UNVERIFIED',
                      DRAFT, 'data:image', 'image_url', 'photoRefs', 'accountId', 'merchantId',
                      'sourceEntryId', 'entryId', 'categoryId', 'ledgerGrant', 'snapshot'):
        assert forbidden not in text, forbidden
    return data['summary']


def assert_scope(page, month, kind, period='calendar', income=False):
    ready(page, kind)
    expect(page.locator('[data-ledger-month]')).to_have_text(month.replace('-', ' 年 ') + ' 月')
    expect(page.locator(f'[data-ledger-period="{period}"]')).to_have_attribute('aria-pressed', 'true')
    assert page.locator('[data-ledger-income]').is_checked() == income


def evidence(page, month, kind='expense', category=None):
    selector = f'[data-ledger-evidence][data-month="{month}"][data-kind="{kind}"]'
    selector += ':not([data-category-index])' if category is None else f'[data-category-index="{category}"]'
    if category is not None:
        details = result(page).locator('details').filter(has=page.locator(selector))
        if details.count() and details.first.get_attribute('open') is None:
            details.first.locator('summary').click()
    result(page).locator(selector).click()
    page.locator('#sheet.open[aria-label="核对账本明细"] [data-ledger-evidence-summary]').wait_for()


def assert_evidence(page, ids, amount):
    expect(page.locator('#sheet.open [data-ledger-evidence-summary]')).to_contain_text(amount)
    rows = page.locator('#sheet.open [data-ledger-entry]')
    assert set(rows.evaluate_all('els=>els.map(el=>el.dataset.ledgerEntry)')) == set(ids)
    assert rows.count() == len(ids), '同一来源不能重复计入核对结果'
    assert page.locator('#sheet.open [data-act="save"],#sheet.open [data-view-action="edit"],#sheet.open [data-view-action="delete"]').count() == 0


def close_evidence(page, back=False):
    if back:
        page.go_back()
    else:
        page.locator('[data-ledger-evidence-close]').click()
    page.locator('#sheet.open').wait_for(state='hidden')
    expect(page.locator('#sp-life-chat')).to_be_visible()
    page.wait_for_function("document.activeElement?.matches('[data-ledger-evidence]')")


def run(page, width):
    errors, payloads, held = [], [], []
    fail, hold = [False], [False]
    page.on('pageerror', lambda error: errors.append(str(error)))
    open_life(page)
    configure(page)
    seed(page)
    snapshot = ledger_snapshot(page)

    def mock(route):
        payloads.append(route.request.post_data_json)
        if hold[0]:
            held.append(route)
        elif fail[0]:
            fail[0] = False
            route.fulfill(status=500, body='PRIVATE_PROVIDER_FAILURE')
        else:
            route.fulfill(json={'choices': [{'message': {'content': f'MODEL_ONLY_UNVERIFIED 第 {len(payloads)} 次模拟回答：净支出 ¥999999.99。'}}]})

    page.route('https://life-ai.invalid/**', mock)
    page.route('https://changed-ledger.invalid/**', mock)
    page.locator('[data-life-chat]').click()

    # 普通会话和照片都存在时，分析仍只发送本次问题及已预览的聚合数据。
    page.locator('#life-chat-input').fill(PRIVATE_CHAT + ' 这是虚构的普通聊天。')
    page.locator('[data-life-chat-send]').click()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    idle(page)
    expect(page.locator('[data-ledger-result]')).to_have_count(0)
    page.locator('[data-life-chat-photo]').click()
    page.locator('#lchat-file').set_input_files(image(page, 'PRIVATE_LEDGER_PHOTO.png', '#607d8b'))
    page.locator('#life-chat-input').fill('帮我分析 2026-06 的消费情况。')
    page.locator('[data-life-chat-send]').click()
    assert_scope(page, '2026-06', 'month')
    expect(page.locator('[data-ledger-preview]')).to_contain_text('净支出 ¥440.00')
    assert len(payloads) == 1
    capture(page, 'monthly-preview', width, '#sheet')
    page.locator('[data-ledger-analysis="compare"]').click()
    ready(page, 'compare')
    preview = page.locator('[data-ledger-preview]').inner_text()
    for text in ('2026-05', '2026-06', '390.00', '440.00'):
        assert text in preview
    capture(page, 'compare-preview', width, '#sheet')
    page.locator('[data-ledger-analysis="trend"]').click()
    ready(page, 'trend')
    for month in MONTHS:
        assert month in page.locator('[data-ledger-preview]').inner_text()
    capture(page, 'trend-preview', width, '#sheet')
    page.locator('[data-ledger-analysis="month"]').click()
    ready(page, 'month')
    page.locator('[data-ledger-cancel]').click()
    idle(page)
    assert len(payloads) == 1
    expect(page.locator('[data-ledger-result]')).to_have_count(0)
    page.locator('[data-life-chat-retry]').click()
    assert_scope(page, '2026-06', 'month')
    page.locator('[data-ledger-approve]').click()
    idle(page)
    expect(page.locator('[data-ledger-result]')).to_have_count(1)
    monthly = summary(payloads[-1])
    assert 'analysis' not in monthly, '单月请求保持既有负载结构'
    assert monthly['scope'] == {'month':'2026-06','period':'calendar','includeIncome':False}
    assert monthly['totals'] == {'expenseFen':44000,'grossExpenseFen':45000,'refundFen':1000,
                                 'reimbursementOffsetFen':0,'expenseCount':2,'refundCount':1}
    assert 'income' not in monthly
    persisted = json.dumps(read_rows(page, 'lifeDrafts'), ensure_ascii=False)
    for forbidden in ('ledgerGrant', 'ledgerResults', 'categoryItems', 'reimbursementMode', 'expenseFen', PRIVATE_NOTE):
        assert forbidden not in persisted, '原始核对快照不得持久化：' + forbidden
    expect(result(page)).to_contain_text('440.00')
    assert '999999.99' not in result(page).inner_text(), '核对卡不能把模型数值当成事实'
    followups(page, ['compare', 'trend'])
    capture(page, 'monthly-result', width, '#sp-life-chat')

    before = len(payloads)
    # 明细尚在读取时立即关闭，迟到结果不得重新打开抽屉。
    page.evaluate('''() => {
      const trigger=document.querySelector('[data-ledger-result] [data-ledger-evidence]:not([data-category-index])');
      trigger.focus();trigger.click();document.querySelector('[data-ledger-evidence-close]').click();
    }''')
    page.wait_for_timeout(350)
    expect(page.locator('#sheet.open')).to_have_count(0)
    page.wait_for_function("document.activeElement?.matches('[data-ledger-evidence]')")
    assert len(payloads) == before
    evidence(page, '2026-06')
    assert_evidence(page, JUNE_EXPENSES, '440.00')
    capture(page, 'expense-evidence', width, '#sheet')
    close_evidence(page, back=True)
    evidence(page, '2026-06', category=0)
    assert_evidence(page, {'91601','91604'}, '390.00')
    capture(page, 'category-evidence', width, '#sheet')
    close_evidence(page)
    assert len(payloads) == before
    assert_read_only(page, snapshot)

    # 固定建议只改分析选择；取消和系统返回不发送，也不吞掉未发送的文字与照片。
    page.locator('#life-chat-input').fill(DRAFT)
    page.locator('[data-life-chat-photo]').click()
    page.locator('#lchat-file').set_input_files(image(page, 'UNSENT_PRIVATE_PHOTO.png', '#805d93'))
    expect(page.locator('#life-chat-photos img')).to_have_count(1)
    photos = page.locator('#life-chat-photos img').count()
    users = page.locator('.life-chat-bubble.user').count()
    page.evaluate('''() => {
      const cards=document.querySelectorAll('[data-ledger-result]'), last=cards[cards.length-1];
      last.querySelector('[data-ledger-followup="0"]').click();
      const current=document.querySelectorAll('[data-ledger-result]');
      current[current.length-1].querySelector('[data-ledger-followup="1"]').click();
    }''')
    ready(page, 'compare')
    expect(page.locator('.life-chat-bubble.user')).to_have_count(users + 1)
    expect(page.locator('#sheet.open[aria-label="账本分析范围"]')).to_have_count(1)
    assert len(payloads) == before
    page.locator('[data-ledger-cancel]').click()
    idle(page)
    assert len(payloads) == before
    expect(page.locator('#life-chat-input')).to_have_value(DRAFT)
    assert page.locator('#life-chat-photos img').count() == photos
    choose_followup(page, 'trend')
    ready(page, 'trend')
    page.go_back()
    page.locator('#sheet.open').wait_for(state='hidden')
    idle(page)
    assert len(payloads) == before
    expect(page.locator('#life-chat-input')).to_have_value(DRAFT)
    expect(page.locator('[data-ledger-result]')).to_have_count(1)

    choose_followup(page, 'compare')
    ready(page, 'compare')
    page.locator('[data-ledger-prev]').click()
    page.locator('[data-ledger-period="accounting"]').click()
    page.locator('[data-ledger-income]').check()
    assert_scope(page, '2026-05', 'compare', 'accounting', True)
    preview = page.locator('[data-ledger-preview]').inner_text()
    assert '2026/4/20' in preview and '2026/6/19' in preview
    capture(page, 'manual-range-preview', width, '#sheet')
    page.locator('[data-ledger-approve]').click()
    idle(page)
    compare = summary(payloads[-1])
    assert compare['scope'] == {'month':'2026-05','period':'accounting','includeIncome':True,'analysis':'compare'}
    assert compare['analysis']['kind'] == 'compare'
    assert [p['scope']['month'] for p in compare['analysis']['periods']] == ['2026-04','2026-05']
    assert [p['totals']['expenseFen'] for p in compare['analysis']['periods']] == [39000,44000]
    assert compare['analysis']['change']['expenseChangeFen'] == 5000
    assert abs(compare['analysis']['change']['expenseChangePercent'] - 12.82) < 0.01
    followups(page, ['month', 'trend'])
    capture(page, 'compare-result', width, '#sp-life-chat')
    expect(page.locator('#life-chat-input')).to_have_value(DRAFT)
    assert page.locator('#life-chat-photos img').count() == photos

    # 重新回答、取消后的重试都保留用户手选的分析模式、月份和口径。
    count = len(payloads)
    page.locator('[data-chat-regenerate]').click()
    assert_scope(page, '2026-05', 'compare', 'accounting', True)
    page.locator('[data-ledger-cancel]').click()
    idle(page)
    assert len(payloads) == count
    page.locator('[data-life-chat-retry]').click()
    assert_scope(page, '2026-05', 'compare', 'accounting', True)
    page.locator('[data-ledger-approve]').click()
    idle(page)
    assert summary(payloads[-1]) == compare

    choose_followup(page, 'trend')
    ready(page, 'trend')
    page.locator('[data-ledger-next]').click()
    page.locator('[data-ledger-period="calendar"]').click()
    page.locator('[data-ledger-income]').uncheck()
    assert_scope(page, '2026-06', 'trend')
    page.locator('[data-ledger-approve]').click()
    idle(page)
    trend = summary(payloads[-1])
    assert trend['analysis']['kind'] == 'trend'
    assert [p['scope']['month'] for p in trend['analysis']['periods']] == MONTHS
    assert [p['totals']['expenseFen'] for p in trend['analysis']['periods']] == NETS
    assert trend['analysis']['change']['expenseChangeFen'] == 29000
    assert abs(trend['analysis']['change']['expenseChangePercent'] - 193.33) < 0.01
    followups(page, ['month', 'compare'])
    capture(page, 'trend-result', width, '#sp-life-chat')
    assert_read_only(page, snapshot)

    # 预览之后换服务、账单或报销口径均拒绝旧授权，且不会静默发出请求。
    count = len(payloads)
    page.locator('[data-chat-regenerate]').click()
    ready(page, 'trend')
    setting(page, 'ai.baseUrl', 'https://changed-ledger.invalid/v1')
    page.locator('[data-ledger-approve]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('配置已变化')
    idle(page)
    assert len(payloads) == count
    page.locator('[data-life-chat-retry]').click()
    assert_scope(page, '2026-06', 'trend')
    expect(page.locator('.life-ledger-destination')).to_contain_text('changed-ledger.invalid')
    mutate_entry(page, 91601, {'amount':41000,'updatedAt':2})
    snapshot = ledger_snapshot(page)
    page.locator('[data-ledger-approve]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('变化')
    idle(page)
    assert len(payloads) == count
    page.locator('[data-life-chat-retry]').click()
    ready(page, 'trend')
    setting(page, 'reimburse.countAsIncome', True)
    page.locator('[data-ledger-approve]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('变化')
    idle(page)
    assert len(payloads) == count

    # 在途修改也不能留下成功核对卡；旧卡下钻必须拒绝错配的当前明细。
    page.locator('[data-life-chat-retry]').click()
    ready(page, 'trend')
    hold[0] = True
    old_cards = page.locator('[data-ledger-result]').count()
    page.locator('[data-ledger-approve]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('正在想')
    page.wait_for_timeout(100)
    assert len(held) == 1
    expect(page.locator('[data-ledger-result]')).to_have_count(old_cards)
    mutate_entry(page, 91601, {'amount':42000,'updatedAt':3})
    snapshot = ledger_snapshot(page)
    held.pop().fulfill(json={'choices':[{'message':{'content':'STALE_REPLY_MUST_NOT_BECOME_SUCCESS'}}]})
    hold[0] = False
    expect(page.locator('#life-chat-status')).to_contain_text('变化')
    idle(page)
    assert 'STALE_REPLY' not in '\n'.join(page.locator('.assistant').all_inner_texts())
    expect(page.locator('[data-ledger-result]')).to_have_count(old_cards)
    before = len(payloads)
    result(page).locator('[data-ledger-evidence][data-month="2026-06"][data-kind="expense"]:not([data-category-index])').click()
    expect(page.locator('#life-chat-status')).to_contain_text('变化')
    assert page.locator('#sheet.open [data-ledger-entry]').count() == 0
    assert len(payloads) == before
    capture(page, 'stale-evidence', width, '#sp-life-chat')
    page.locator('[data-life-chat-retry]').click()
    assert_scope(page, '2026-06', 'trend')
    hold[0] = True
    page.locator('[data-ledger-approve]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('正在想')
    page.wait_for_timeout(100)
    assert len(held) == 1
    setting(page, 'ai.baseUrl', 'https://life-ai.invalid/v1')
    held.pop().fulfill(json={'choices':[{'message':{'content':'OLD_PROVIDER_REPLY_MUST_NOT_BECOME_SUCCESS'}}]})
    hold[0] = False
    expect(page.locator('#life-chat-status')).to_contain_text('变化')
    idle(page)
    assert 'OLD_PROVIDER_REPLY' not in '\n'.join(page.locator('.assistant').all_inner_texts())
    expect(page.locator('[data-ledger-result]')).to_have_count(old_cards)
    page.locator('[data-life-chat-retry]').click()
    assert_scope(page, '2026-06', 'trend')
    page.locator('[data-ledger-income]').check()
    ready(page, 'trend')
    page.locator('[data-ledger-approve]').click()
    idle(page)
    fresh = summary(payloads[-1])
    assert fresh['reimbursementMode'] == 'income'
    assert fresh['totals']['expenseFen'] == 46000
    assert fresh['income'] == {'incomeFen':86000,'reimbursementIncomeFen':6000,'count':2}
    before = len(payloads)
    evidence(page, '2026-06', kind='income')
    assert_evidence(page, {'91603', MAY_REIMBURSED}, '860.00')
    capture(page, 'reimbursement-evidence', width, '#sheet')
    page.locator(f'#sheet.open [data-ledger-entry="{MAY_REIMBURSED}"]').click()
    expect(page.locator('#sp-entry-view .entry-audit')).to_contain_text('账单 ID：' + MAY_REIMBURSED)
    expect(page.locator('#sp-entry-view')).to_contain_text('100.00')
    capture(page, 'reimbursement-source', width, '#sp-entry-view')
    page.locator('#sp-entry-view [data-act="back"]').click()
    page.locator('#sp-entry-view').wait_for(state='detached')
    expect(page.locator('#life-chat-input')).to_have_value(DRAFT)
    assert len(payloads) == before
    assert_read_only(page, snapshot)

    # 核对快照只在页面内存；刷新不复活旧授权，重新回答再次确认后可重建。
    page.reload()
    page.locator('#fab').wait_for()
    page.locator('[data-page="page-life"]').click()
    page.locator('[data-life-chat]').click()
    expect(page.locator('[data-ledger-result]')).to_have_count(0)
    assert len(payloads) == before
    watch_writes(page)
    page.locator('[data-chat-regenerate]').click()
    ready(page)
    page.locator('[data-ledger-analysis="trend"]').click()
    ready(page, 'trend')
    page.locator('[data-ledger-approve]').click()
    idle(page)
    expect(page.locator('[data-ledger-result]')).to_have_count(1)
    summary(payloads[-1])

    # 新会话中失败、取消与停止请求均无成功卡；空月可本地换到非空趋势范围。
    page.locator('[data-chat-start]').click()
    page.locator('.chat-welcome').wait_for()
    page.locator('#life-chat-input').fill('帮我分析 2026-06 的消费情况。')
    page.locator('[data-life-chat-send]').click()
    ready(page, 'month')
    page.locator('[data-ledger-analysis="trend"]').click()
    ready(page, 'trend')
    fail[0] = True
    page.locator('[data-ledger-approve]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('暂时不可用')
    idle(page)
    expect(page.locator('[data-ledger-result]')).to_have_count(0)
    assert 'PRIVATE_PROVIDER_FAILURE' not in page.locator('#sp-life-chat').inner_text()
    page.locator('[data-life-chat-retry]').click()
    assert_scope(page, '2026-06', 'trend')
    hold[0] = True
    page.locator('[data-ledger-approve]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('正在想')
    page.locator('[data-life-chat-stop]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('已停止')
    for route in held:
        try:
            route.abort()
        except Exception:
            pass
    held.clear()
    hold[0] = False
    expect(page.locator('[data-ledger-result]')).to_have_count(0)
    count = len(payloads)
    page.locator('[data-life-chat-retry]').click()
    assert_scope(page, '2026-06', 'trend')
    page.locator('[data-ledger-analysis="month"]').click()
    page.locator('[data-ledger-next]').click()
    expect(page.locator('[data-ledger-error]')).to_contain_text('暂无账单')
    assert page.locator('[data-ledger-approve]').is_disabled()
    capture(page, 'empty-month', width, '#sheet')
    page.locator('[data-ledger-analysis="trend"]').click()
    ready(page, 'trend')
    page.locator('[data-ledger-cancel]').click()
    idle(page)
    assert len(payloads) == count
    assert_read_only(page, snapshot)
    for payload in payloads[1:]:
        summary(payload)
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(**({'executable_path':os.environ['GLEAM_E2E_CHROMIUM']} if os.environ.get('GLEAM_E2E_CHROMIUM') else {}))
        for width in (360, 390, 430, 1280):
            context = browser.new_context(viewport={'width':width,'height':844}, reduced_motion='reduce')
            page = context.new_page()
            try:
                run(page, width)
            except Exception:
                page.screenshot(path=str(OUT / f'failed-{width}.png'), animations='disabled')
                raise
            finally:
                context.close()
            print(f'PASS verified chat ledger analysis {width}', flush=True)
        browser.close()
