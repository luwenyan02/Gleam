"""周期账开始日期、保存补跑、旧规则显式补记；全部账单均为虚构数据。"""
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import expect, sync_playwright
from test_acceptance_fixes import seed
from test_life_ai import read_rows
from test_save_atomic import fail_once
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/recurring-initial'
DUE = int(datetime.fromisoformat('2026-11-02T09:00:00+08:00').timestamp() * 1000)
NEXT = int(datetime.fromisoformat('2026-12-02T09:00:00+08:00').timestamp() * 1000)


def pending(page):
    return next((r['value'] for r in read_rows(page, 'settings') if r['key'] == 'recurring.pendingConfirms'), [])


def open_recurring(page):
    page.locator('[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-recurring"]').click()
    expect(page.locator('#sp-recurring.open')).to_be_visible()


def new_rule(page, name, confirm=False, fail_save=False):
    page.locator('[data-rc-add]').click()
    page.locator('#sheet.open[aria-label="新建周期账"] #rc-name').wait_for()
    page.locator('#rc-name').fill(name)
    page.locator('#rc-amount').fill('10')
    page.locator('#rc-dom').fill('2')
    if confirm:
        page.locator('#rc-confirm').click()
    page.locator('#rc-start').click()
    page.locator('.dw-panel.dw-open[role="dialog"]').wait_for()
    page.locator('.dw-col[aria-label="日"]').press('Home')
    expect(page.locator('.dw-col[aria-label="日"]')).to_have_attribute('aria-valuetext', '1日')
    page.locator('.dw-confirm').click()
    page.locator('.dw-panel').wait_for(state='detached')
    expect(page.locator('#rc-start')).to_have_text('2026-11-01')
    rules_before = len(read_rows(page, 'recurringRules'))
    entries_before = read_rows(page, 'entries')
    if fail_save:
        fail_once(page, 'entries')
    # 同一个保存事件连续点击两次，不应创建两条规则或重复补跑。
    page.locator('#sheet [data-act="save"]').evaluate('b=>{b.click();b.click()}')
    if fail_save:
        expect(page.locator('#toast')).to_contain_text('规则已保存，入账未完成')
        assert len(read_rows(page, 'recurringRules')) == rules_before + 1
        assert read_rows(page, 'entries') == entries_before
        page.locator('#sheet.open [data-act="save"]').click()
    try:
        page.locator('#sheet.open').wait_for(state='hidden', timeout=6000)
    except Exception:
        print('SAVE DIAGNOSTIC', name, page.locator('#toast').inner_text(), read_rows(page, 'recurringRules'), pending(page), flush=True)
        raise


def run(browser, width, dark=False):
    context = browser.new_context(viewport={'width': width, 'height': 890}, device_scale_factor=3 if width == 400 else 1,
                                  has_touch=True, is_mobile=width < 600, timezone_id='Asia/Shanghai', service_workers='block')
    external, errors = [], []
    context.route('**/*', lambda route: route.continue_() if urlsplit(route.request.url).netloc == urlsplit(URL).netloc
                  else (external.append(route.request.url), route.abort()))
    page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.set_fixed_time(datetime.fromisoformat('2026-11-04T12:00:00+08:00'))
    page.goto(URL); page.locator('#fab').wait_for(); seed(page, count=0)
    if dark:
        page.evaluate("document.documentElement.dataset.theme='dark';document.documentElement.style.setProperty('--seed-type','1.25')")
    open_recurring(page)
    new_rule(page, '虚构自动补跑', fail_save=width == 400 and not dark)
    expect(page.locator('[data-id]').filter(has_text='虚构自动补跑')).to_have_count(1)
    expect(page.locator('[data-id]').filter(has_text='虚构自动补跑')).to_contain_text('下次 12月2日')
    entries = read_rows(page, 'entries')
    assert entries[0]['occurredAt'] == DUE and entries[0]['amount'] == 1000
    rules = read_rows(page, 'recurringRules')
    assert len(rules) == 1 and rules[0]['nextRunAt'] == NEXT
    assert read_rows(page, 'accounts')[0]['balance'] == -1000
    row = page.locator('[data-id]').filter(has_text='虚构自动补跑')
    row.click(); expect(page.locator('#sheet.open[aria-label="编辑周期账"] #rc-name')).to_have_value('虚构自动补跑'); page.locator('#sheet.open [data-act="save"]').click(); page.locator('#sheet.open').wait_for(state='hidden')
    assert len(read_rows(page, 'entries')) == 1
    new_rule(page, '虚构金额待确认', confirm=True)
    expect(page.locator('[aria-label="待确认入账"]')).to_contain_text('1 笔')
    assert len(read_rows(page, 'entries')) == 1 and len(pending(page)) == 1
    assert pending(page)[0]['dueAt'] == DUE
    # 模拟v1.11.45保存出的旧规则：首期已错误跳至12月2日。
    legacy_id = page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction('recurringRules','readwrite');
      const id=await new Promise(r=>{const q=tx.objectStore('recurringRules').add({name:'虚构旧规则漏记',type:'expense',amount:1500,amountConfirm:false,
        freq:'monthly',days:[2],startDate:new Date(2026,10,1,9).getTime(),nextRunAt:new Date(2026,11,2,9).getTime(),
        accountId:1,categoryId:2,enabled:true,createdAt:Date.now(),updatedAt:Date.now()});q.onsuccess=()=>r(q.result)});
      await new Promise(r=>tx.oncomplete=r);db.close();return id;
    }''')
    # 重新进入读取旧规则，不直接操作业务模块。
    page.locator('#sp-recurring .sub-head [data-act="back"]').click()
    page.locator('#sp-recurring').wait_for(state='detached')
    page.locator('#page-mine [data-sub="sp-recurring"]').click()
    check = page.locator(f'[data-backfill="{legacy_id}"]')
    check.click()
    dialog = page.locator('#dialog-scrim.show')
    expect(dialog).to_contain_text('2026-11-02')
    expect(dialog).to_contain_text('1 笔')
    assert len(read_rows(page, 'entries')) == 1
    dialog.locator('[data-act="cancel"]').click()
    assert len(read_rows(page, 'entries')) == 1
    page.locator('#toast.show').wait_for(state='hidden')
    assert_usable(page, '#sp-recurring')
    page.screenshot(path=str(OUT / f'legacy-{width}-{"dark" if dark else "light"}.png'), animations='disabled')
    check.click(); dialog.locator('[data-act="ok"]').click()
    check.wait_for(state='detached')
    assert len(read_rows(page, 'entries')) == 2
    assert read_rows(page, 'accounts')[0]['balance'] == -2500
    # 待确认项只在确认后入账；重复点击与刷新不能重新生成。
    page.locator('#sp-recurring [data-act="pending"]').click()
    page.locator('[data-book="0"]').evaluate('b=>{b.click();b.click()}')
    page.locator('#sheet.open').wait_for(state='hidden')
    assert len(read_rows(page, 'entries')) == 3 and pending(page) == []
    page.reload(); page.locator('#fab').wait_for(); open_recurring(page)
    assert len(read_rows(page, 'entries')) == 3 and pending(page) == []
    assert page.locator('[data-backfill]').count() == 0
    assert read_rows(page, 'accounts')[0]['balance'] == -3500
    assert not errors, errors
    assert not external, external
    context.close()
    print('PASS recurring initial/save/backfill', width, 'dark large text' if dark else 'light', flush=True)


def run_handoff(browser):
    context = browser.new_context(viewport={'width': 400, 'height': 890}, device_scale_factor=3,
                                  has_touch=True, is_mobile=True, timezone_id='Asia/Shanghai', service_workers='block')
    context.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(URL).netloc else r.abort())
    page = context.new_page(); errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.set_fixed_time(datetime.fromisoformat('2026-11-04T12:00:00+08:00'))
    page.goto(URL); page.locator('#fab').wait_for(); seed(page, count=0); open_recurring(page)
    page.locator('[data-rc-add]').click(); page.locator('#sheet.open #rc-name').wait_for()
    page.locator('#rc-name').fill('虚构旧保存A'); page.locator('#rc-amount').fill('10'); page.locator('#rc-dom').fill('5')
    # 只延迟只读排期查询的回调，模拟保存后的长时间补跑；不延迟写事务、不改生产代码。
    page.evaluate(r'''() => {
      const original = IDBObjectStore.prototype.getAll;
      const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess');
      window.__heldRuleReads = []; window.__holdRuleReads = true;
      IDBObjectStore.prototype.getAll = function(...args) {
        const request = Reflect.apply(original, this, args);
        if (this.name === 'recurringRules' && this.transaction.mode === 'readonly' && window.__holdRuleReads) {
          Object.defineProperty(request, 'onsuccess', {
            get() { return success.get.call(request); },
            set(handler) { success.set.call(request, event => window.__heldRuleReads.push(() => handler.call(request, event))); },
          });
        }
        return request;
      };
      window.__oldSavingButton = document.querySelector('#sheet [data-act="save"]');
    }''')
    page.locator('#sheet [data-act="save"]').click()
    page.wait_for_function('window.__heldRuleReads.length > 0')
    assert page.evaluate("""async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const count=await new Promise(r=>{const q=db.transaction('recurringRules').objectStore('recurringRules').count();q.onsuccess=()=>r(q.result)});
      db.close();return count;
    }""") == 1
    page.locator('#sheet [data-act="close"]').click()
    page.locator('[data-rc-add]').click(); page.locator('#sheet.open #rc-name').wait_for()
    page.locator('#rc-name').fill('虚构新草稿B'); page.locator('#rc-amount').fill('22.22'); page.locator('#rc-dom').fill('6')
    page.evaluate("""() => {
      window.__holdRuleReads = false;
      window.__heldRuleReads.splice(0).forEach(release => release());
    }""")
    page.wait_for_function('!window.__oldSavingButton.disabled')
    expect(page.locator('#sheet.open #rc-name')).to_have_value('虚构新草稿B')
    expect(page.locator('#sheet.open #rc-amount')).to_have_value('22.22')
    expect(page.locator('#sheet.open #rc-dom')).to_have_value('6')
    page.locator('#sheet [data-act="save"]').click(); page.locator('#sheet.open').wait_for(state='hidden')
    assert len(read_rows(page, 'recurringRules')) == 2
    assert len(read_rows(page, 'entries')) == 0
    assert not errors, errors
    context.close()
    print('PASS recurring save preserves a later draft 400', flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        run_handoff(browser)
        for width in [360, 390, 400, 430, 1280]:
            run(browser, width)
        run(browser, 400, dark=True)
        browser.close()
