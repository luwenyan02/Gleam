"""Category-budget drilldown shares period, descendants and net-expense semantics."""
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4602/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/budget-category-details'
SEED = """async countAsIncome => {
  const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
  const names=['categories','accounts','entries','budgets','categoryBudgets','settings'];
  const tx=db.transaction(names,'readwrite');
  for(const name of names.filter(n=>n!=='settings'))tx.objectStore(name).clear();
  const stamp={createdAt:Date.now(),updatedAt:Date.now()};
  const categories=[{id:1,name:'交通',kind:'expense'},{id:2,name:'公交',parentId:1,kind:'expense'},
    {id:3,name:'地铁',parentId:1,kind:'expense'},{id:4,name:'购物',kind:'expense'},
    {id:5,name:'数码',parentId:4,kind:'expense'},{id:6,name:'空分类',kind:'expense'},{id:7,name:'其他',kind:'expense'}];
  categories.forEach(c=>tx.objectStore('categories').put({...stamp,...c,icon:'ic-tag',sortOrder:c.id}));
  tx.objectStore('accounts').put({...stamp,id:1,name:'虚构账户',group:'cash',balance:0,sortOrder:1,hidden:false,countInNetWorth:true});
  const time=s=>new Date(s).getTime();
  const rows=[
    {id:1,categoryId:2,amount:10000,occurredAt:time('2026-10-05T00:00:00+08:00')},
    {id:2,categoryId:1,amount:3000,occurredAt:time('2026-10-20T12:00:00+08:00')},
    {id:3,categoryId:3,amount:2000,refundFlag:true,refundOfEntryId:1,occurredAt:time('2026-11-04T23:59:59.999+08:00')},
    {id:4,categoryId:2,amount:10000,reimburseStatus:'done',reimbursedAmount:4000,reimbursedAt:time('2026-10-15T12:00:00+08:00'),reimburseAccountId:1,occurredAt:time('2026-10-10T12:00:00+08:00')},
    {id:5,categoryId:2,amount:99999,occurredAt:time('2026-10-04T23:59:59.999+08:00')},
    {id:6,categoryId:3,amount:88888,occurredAt:time('2026-11-05T00:00:00+08:00')},
    {id:7,categoryId:7,amount:12345,occurredAt:time('2026-10-12T12:00:00+08:00')},
    {id:8,categoryId:2,amount:45600,deletedAt:Date.now()-1000,occurredAt:time('2026-10-12T12:00:00+08:00')},
    {id:9,categoryId:5,amount:50000,refundFlag:true,refundOfEntryId:10,occurredAt:time('2026-10-12T12:00:00+08:00')},
    {id:10,categoryId:5,amount:60000,occurredAt:time('2026-09-10T12:00:00+08:00')},
    {id:11,categoryId:5,amount:2000,occurredAt:time('2026-10-13T12:00:00+08:00')},
  ];
  rows.forEach(e=>tx.objectStore('entries').put({...stamp,type:'expense',accountId:1,note:'虚构预算明细',reimburseStatus:'none',deletedAt:0,...e}));
  for(const month of ['2026-09','2026-10']){
    tx.objectStore('budgets').put({...stamp,month,totalLimit:100000,autoRenew:false});
    for(const categoryId of [1,4,6])tx.objectStore('categoryBudgets').add({...stamp,month,categoryId,limit:50000});
  }
  tx.objectStore('settings').put({key:'accounting.monthStartDay',value:5});
  tx.objectStore('settings').put({key:'reimburse.countAsIncome',value:countAsIncome});
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}"""


def ids(page):
    return sorted(page.locator('#sr-results [data-eid]').evaluate_all('els=>els.map(e=>Number(e.dataset.eid))'))


def back(page):
    page.locator('#sp-search .sub-head [data-act="back"]').click()
    page.locator('#sp-search').wait_for(state='detached')


def run(browser, width, scale, theme, income):
    context = browser.new_context(viewport={'width': width, 'height': 890 if width == 400 else 844}, device_scale_factor=3 if width == 400 else 1,
                                  timezone_id='Asia/Shanghai', locale='zh-CN', service_workers='block', reduced_motion='reduce')
    external, errors = [], []
    context.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(URL).netloc else (external.append(r.request.url), r.abort()))
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.clock.set_fixed_time(datetime.fromisoformat('2026-10-18T12:00:00+08:00'))
    page.goto(URL)
    page.locator('#fab').wait_for()
    page.evaluate(SEED, income)
    page.reload()
    page.locator('#fab').wait_for()
    page.evaluate('([s,t])=>{document.documentElement.style.setProperty("--seed-type",s);document.documentElement.dataset.theme=t}', [str(scale), theme])
    page.locator('[data-page="page-mine"]').click()
    page.locator('[data-sub="sp-budget"]').click()
    budget = page.locator('#sp-budget')
    transport = budget.get_by_role('button', name='查看交通预算明细', exact=True)
    used = '¥210.00' if income else '¥170.00'
    expect(transport).to_contain_text(used)
    transport.scroll_into_view_if_needed()
    scroll = budget.locator('.sub-body').evaluate('e=>e.scrollTop')
    label = f'{width}-text{scale}-{theme}-income{income}'
    page.screenshot(path=str(OUT / f'budget-{label}.png'), animations='disabled')
    transport.focus()
    transport.press('Enter')
    expect(page.locator('#sp-search .sub-head h2')).to_have_text('交通 · 预算明细')
    expect(page.locator('#sr-date-from')).to_have_text('2026/10/05 ▾')
    expect(page.locator('#sr-date-to')).to_have_text('2026/11/04 ▾')
    expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text(used.replace('¥', ''))
    assert ids(page) == [1, 2, 3, 4], 'Must include parent, children, refund and reimbursed expense only'
    expect(page.locator('[data-sf="income"] .sc-amount')).to_have_text('0.00')
    page.screenshot(path=str(OUT / f'details-{label}.png'), animations='disabled')
    back(page)
    expect(transport).to_be_focused()
    assert abs(budget.locator('.sub-body').evaluate('e=>e.scrollTop') - scroll) < 2
    expect(budget.locator('[data-act="period"]')).to_contain_text('2026-10')
    shopping = budget.get_by_role('button', name='查看购物预算明细', exact=True)
    expect(shopping).to_contain_text('-¥480.00')
    shopping.click()
    expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text('-480.00')
    assert ids(page) == [9, 11]
    back(page)
    budget.get_by_role('button', name='查看空分类预算明细', exact=True).click()
    expect(page.locator('#sr-results .sr-empty')).to_be_visible()
    expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text('0.00')
    back(page)
    budget.locator('[data-act="period"]').click()
    page.locator('.dw-panel').evaluate('e=>e.__mwSet(2026,9)')
    page.locator('.dw-confirm').click()
    expect(budget.locator('[data-act="period"]')).to_contain_text('2026-09')
    transport.click()
    expect(page.locator('#sr-date-from')).to_have_text('2026/09/05 ▾')
    expect(page.locator('#sr-date-to')).to_have_text('2026/10/04 ▾')
    expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text('999.99')
    assert ids(page) == [5]
    back(page)
    expect(budget.locator('[data-act="period"]')).to_contain_text('2026-09')
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    assert not errors, errors
    assert not external, external
    context.close()
    print('PASS budget category details', label, flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width, scale in [(360, 1), (390, 1), (400, 1), (400, 1.3), (430, 1), (1280, 1)]:
            for income in [False, True]:
                run(browser, width, scale, 'dark' if income else 'light', income)
        browser.close()
