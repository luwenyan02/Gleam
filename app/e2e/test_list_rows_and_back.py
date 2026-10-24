"""用户反馈回归：统一明细两行结构、日期及选择器的分层返回。数据完全虚构。"""
import os
import traceback
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
SHOTS = Path(os.environ.get('GLEAM_E2E_SCREENSHOTS', Path(__file__).parents[2] / '.tmp/tests/e2e/screenshots'))
SHOTS.mkdir(parents=True, exist_ok=True)

def fixture(page):
    date = page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['entries','categories','accounts'],'readwrite');
      const now=Date.now(),d=new Date();d.setDate(d.getDate()-1);d.setHours(15,50,0,0);
      for(const name of ['entries','categories','accounts'])tx.objectStore(name).clear();
      const stamp={createdAt:now,updatedAt:now};
      const accounts=[{id:1,name:'演示现金',group:'cash'},{id:2,name:'演示工资卡',group:'debit'},{id:3,name:'演示小林',group:'receivable'}].map(a=>({...a,...stamp,balance:0,hidden:false,countInNetWorth:true,sortOrder:a.id}));
      for(const c of [{id:1,name:'出行',kind:'expense',icon:'ic-bus'},{id:2,name:'公交',kind:'expense',parentId:1,icon:'ic-bus'},{id:3,name:'午餐',kind:'expense',icon:'ic-bowl'},{id:4,name:'工资',kind:'income',icon:'ic-coin'}])tx.objectStore('categories').put({...c,...stamp,sortOrder:c.id});
      const entries=[
        {id:1,type:'expense',amount:4865025,accountId:1,categoryId:2,note:'虚构巴士；收付款人：自己'},
        {id:2,type:'expense',amount:1200,accountId:1,categoryId:2,refundFlag:true,refundOfEntryId:1,note:'收付款人：自己'},
        {id:3,type:'expense',amount:5800,accountId:1,categoryId:3,note:'虚构出差工作餐；收付款人：虚构同事',reimburseStatus:'pending'},
        {id:4,type:'income',amount:1000000,accountId:2,categoryId:4},
        {id:5,type:'transfer',amount:1000,fromAccountId:1,toAccountId:2},
        {id:6,type:'loan',loanKind:'lend',amount:5200,fromAccountId:1,toAccountId:3},
        {id:7,type:'expense',amount:9000,accountId:2,categoryId:3,reimburseStatus:'done',reimbursedAmount:6000,reimburseAccountId:1,reimbursedAt:d.getTime()}
      ];
      for(const e of entries){
        tx.objectStore('entries').put({...stamp,deletedAt:0,reimburseStatus:'none',occurredAt:d.getTime(),...e});
        const delta=(id,n)=>{const a=accounts.find(a=>a.id===id);if(a)a.balance+=n};
        if(e.accountId)delta(e.accountId,e.type==='income'||e.refundFlag?e.amount:-e.amount);
        if(e.fromAccountId)delta(e.fromAccountId,-e.amount);
        if(e.toAccountId)delta(e.toAccountId,e.amount);
        if(e.reimburseAccountId)delta(e.reimburseAccountId,e.reimbursedAmount);
      }
      accounts.forEach(a=>tx.objectStore('accounts').put(a));
      await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=()=>j(tx.error)});db.close();
      return `${d.getMonth()+1}月${d.getDate()}日 15:50`;
    }''')
    page.reload();page.wait_for_selector('#hm-days [data-entry-row="1"]')
    return date

def ledger_snapshot(page):
    return page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['accounts','entries']);const read=n=>new Promise(r=>{const q=tx.objectStore(n).getAll();q.onsuccess=()=>r(q.result)});
      const data=await Promise.all(['accounts','entries'].map(read));db.close();return data;
    }''')

def rows(page,width):
    date=fixture(page);before=ledger_snapshot(page);issues=[]
    expected={1:('公交','演示现金'),2:('公交退款','演示现金'),3:('午餐','演示现金'),4:('工资','演示工资卡'),5:('转账','演示现金 → 演示工资卡'),6:('借出','演示现金 → 演示小林'),7:('午餐','演示工资卡')}
    def check(prefix,attribute):
        for ident,(title,account) in expected.items():
            row=page.locator(f'{prefix} [{attribute}="{ident}"]')
            actual_title=row.locator('.e-title').inner_text()
            meta=row.locator('.e-meta').first.inner_text()
            if actual_title.split(' · ')[0]!=title:issues.append(f'{prefix} #{ident} title: {actual_title!r}')
            if not meta.startswith(f'{"15:50" if prefix == "#hm-days" else date} · {account}'):issues.append(f'{prefix} #{ident} meta: {meta!r}')
            if not row.locator('.e-ic').count():issues.append(f'{prefix} #{ident} missing icon')
            # 首页会异步整段刷新；在同一次求值中查找当前节点，避免量到刚被替换的旧节点。
            page.wait_for_function('selector=>document.querySelector(selector)?.getBoundingClientRect().width>0',arg=f'{prefix} [{attribute}="{ident}"] .e-main')
        assert '待报销' in page.locator(f'{prefix} [{attribute}="3"]').inner_text()
        assert '已报销' in page.locator(f'{prefix} [{attribute}="7"]').inner_text()
    check('#hm-days','data-entry-row')
    assert '收付款人' not in page.locator('#hm-days').inner_text()
    assert '虚构巴士' in page.locator('#hm-days').inner_text()
    page.locator('#page-home').screenshot(path=str(SHOTS/f'list-home-{width}.png'))
    page.locator('#hm-quick .hm-all').click()
    page.locator('.picker-mask [data-value="detail"]').click()
    page.locator('#sp-entry-detail [data-id="1"]').wait_for()
    assert '收付款人' not in page.locator('#sp-entry-detail').inner_text()
    assert '虚构巴士' in page.locator('#sp-entry-detail [data-id="1"]').inner_text()
    page.locator('#sp-entry-detail .sub-head [data-act="back"]').click()
    page.locator('#sp-entry-detail').wait_for(state='detached')
    page.locator('#btn-search').click();page.locator('#sr-input').fill('演示')
    page.locator('#sr-results [data-eid="1"]').wait_for();page.wait_for_timeout(400)
    check('#sr-results','data-eid')
    assert '收付款人' not in page.locator('#sr-results').inner_text()
    assert '48,650.25' in page.locator('#sr-results [data-eid="1"]').inner_text()
    assert '虚构出差工作餐' in page.locator('#sr-results [data-eid="3"]').inner_text()
    assert '净支出' in page.locator('#sr-results [data-eid="7"] .sr-net').inner_text()
    page.locator('#sr-results').screenshot(path=str(SHOTS/f'list-search-{width}.png'))
    assert ledger_snapshot(page)==before,'显示变更不能改写账单或账户'
    assert not issues,'\n'.join(issues)
    # 统一排版不得破坏详情入口。
    page.locator('#sr-results [data-eid="2"] .entry-swipe-content').click()
    page.locator('#sp-entry-view.open').wait_for()
    assert page.locator('#sp-entry-view .entry-view-note').inner_text()=='无备注'
    assert ledger_snapshot(page)==before

def open_draft(page):
    page.locator('#fab').click();page.locator('#keypad [data-k="8"]').click()
    page.locator('#note').fill('返回保留虚构草稿')
    page.locator('#date-chip').click();page.locator('.dw-panel.dw-open').wait_for();page.wait_for_timeout(350)

def check_draft(page):
    assert page.locator('.dw-panel.dw-open').count()==0,'返回后日期选择器仍开着'
    assert page.locator('#sheet.open').count()==1,'返回错误地关闭了记账页或离开应用'
    assert page.locator('#amt').inner_text()=='8'
    assert page.locator('#note').input_value()=='返回保留虚构草稿'
    assert page.locator('#sheet').evaluate('e=>!e.inert&&!e.closest("[inert]")')

def browser_date_back(page,width):
    fixture(page);open_draft(page);page.go_back();page.wait_for_timeout(450)
    check_draft(page)
    page.go_back();page.wait_for_timeout(450)
    assert page.locator('#sheet.open').count()==0
    assert page.locator('.viewport').evaluate('e=>!e.inert')
    page.locator('#fab').click();page.locator('#sheet.open').wait_for()

def native_date_back(page,width):
    fixture(page);open_draft(page)
    page.evaluate('document.dispatchEvent(new CustomEvent("gleam:system-back"))')
    page.wait_for_timeout(450);check_draft(page)

def date_tab_order(page,width):
    fixture(page);open_draft(page)
    assert page.locator('.dw-tab').all_text_contents()==['日期','时间']
    assert page.locator('.dw-tab[aria-selected="true"]').inner_text()=='时间'
    assert page.locator('.dw-page-time').is_visible()
    assert not page.locator('.dw-page-date').is_visible()
    page.locator('.dw-tab[data-tab="date"]').click()
    assert page.locator('.dw-page-date').is_visible()
    page.locator('.dw-tab[data-tab="time"]').click()
    assert page.locator('.dw-page-time').is_visible()
    page.screenshot(path=str(SHOTS/f'date-tab-order-{width}.png'))
    page.locator('.dw-tab[data-tab="date"]').click()
    page.go_back();page.wait_for_timeout(450);check_draft(page)
    page.locator('#date-chip').click();page.locator('.dw-panel.dw-open').wait_for()
    assert page.locator('.dw-tab[aria-selected="true"]').inner_text()=='时间'
    page.locator('.dw-confirm').click();page.wait_for_timeout(400);check_draft(page)

def asset_trend(page,width):
    fixture(page);before=ledger_snapshot(page)
    page.locator('.tab[data-page="page-acct"]').click()
    chart=page.locator('#page-acct .balance-trend')
    chart.wait_for()
    assert not chart.locator('.balance-trend-chart').is_visible(),'默认收起趋势图'
    page.screenshot(path=str(SHOTS/f'asset-trend-collapsed-{width}.png'),animations='disabled')
    chart.locator('.balance-trend-heading').click()
    assert chart.locator('.balance-trend-months span').count()==6
    assert chart.locator('.balance-trend-axis span').count()==3
    assert '本月截至当前' in chart.inner_text()
    assert chart.locator('.balance-trend-plot svg').evaluate('e=>!/(NaN|Infinity)/.test(e.innerHTML)')
    assert chart.evaluate('e=>e.scrollWidth<=e.clientWidth+1'),'趋势图不能横向溢出'
    chart.locator('.balance-trend-details summary').click()
    assert chart.locator('.balance-trend-values li').count()==6
    assert '¥' in chart.locator('.balance-trend-values').inner_text()
    chart.locator('.balance-trend-details summary').click()
    initial=chart.locator('[data-trend-month]').get_attribute('value')
    chart.locator('[data-trend-shift="-6"]').click()
    page.wait_for_function('''initial=>{const button=document.querySelector("#page-acct [data-trend-month]");
      return button && button.value!==initial;}''',arg=initial)
    assert chart.locator('.balance-trend-chart').is_visible()
    assert '本月截至当前' not in chart.inner_text()
    chart.locator('[data-trend-shift="6"]').click()
    page.wait_for_function('initial=>document.querySelector("#page-acct [data-trend-month]")?.value===initial',arg=initial)
    assert chart.locator('input[type="month"]').count()==0,'年月选择应使用应用内统一样式'
    chart.locator('[data-trend-month]').click()
    page.locator('.dw-panel.dw-open[aria-label="选择年月"]').wait_for()
    page.screenshot(path=str(SHOTS/f'trend-month-picker-{width}.png'),animations='disabled')
    page.go_back();page.locator('.dw-panel').wait_for(state='detached')
    assert chart.locator('[data-trend-month]').get_attribute('value')==initial,'返回取消不应修改趋势月份'
    chart.locator('[data-trend-month]').click()
    page.locator('.dw-panel.dw-open').wait_for()
    page.locator('.dw-panel').evaluate('panel=>panel.__mwSet(2024,6)')
    page.locator('.dw-confirm').click()
    page.wait_for_function('()=>document.querySelector("#page-acct [data-trend-month]")?.value==="2024-06"')
    page.locator('.dw-panel').wait_for(state='detached')
    assert chart.locator('[data-trend-month]').evaluate('e=>document.activeElement===e'),'选择完成后焦点应返回月份按钮'
    assert chart.locator('.balance-trend-chart').is_visible()
    page.locator('#page-acct .page-head').scroll_into_view_if_needed()
    page.screenshot(path=str(SHOTS/f'asset-trend-{width}.png'),animations='disabled')
    assert ledger_snapshot(page)==before,'图表只能读取账务数据'
    page.locator('[data-acct="1"]').click()
    page.locator('.account-detail-hero .balance-trend').wait_for()
    assert page.locator('.account-detail-hero .balance-trend-months span').count()==6

def concise_copy_and_focus(page,width):
    fixture(page)
    page.locator('.tab[data-page="page-report"]').click()
    page.locator('#report-dim [data-dimension="tag"]').click()
    page.locator('#rank-note').wait_for()
    page.locator('#rank .rank-empty').wait_for()
    assert page.locator('#rank').inner_text()=='该周期暂无已标记支出'
    assert page.locator('#rank-note').inner_text()=='按标签正净额合计计算占比；多标签账单重复计入，未打标签不计入。'
    page.locator('.tab[data-page="page-acct"]').click()
    page.get_by_role('button',name='添加账户',exact=True).click()
    field=page.locator('.acct-form input.note').first
    field.wait_for();page.wait_for_timeout(350)
    field.fill('虚构账户');field.focus()
    style=field.evaluate('e=>{const s=getComputedStyle(e);return {border:s.borderColor,shadow:s.boxShadow,outline:s.outlineStyle,primary:getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()}}')
    assert style['shadow']=='none' and style['outline']=='none','输入框只保留一层轻量焦点边框'
    assert page.locator('#sheet').evaluate('e=>getComputedStyle(e).outlineStyle')=='none','非交互弹层容器不应出现焦点框'
    page.screenshot(path=str(SHOTS/f'quiet-focus-{width}.png'),animations='disabled')
    page.locator('#sheet [data-act="close"]').click()
    page.locator('.tab[data-page="page-mine"]').click()
    page.get_by_role('button',name='分类管理',exact=False).click()
    page.locator('#sp-categories').wait_for()
    assert '点击编辑 · 拖动排序' in page.locator('#sp-categories').inner_text()
    assert '支出为两级分类' not in page.locator('#sp-categories').inner_text()
    page.screenshot(path=str(SHOTS/f'concise-category-{width}.png'),animations='disabled')

def contextual_recommendation(page,width):
    fixture(page)
    fixed=page.evaluate('()=>new Date(new Date().setHours(12,0,0,0)).getTime()')
    page.clock.set_fixed_time(fixed / 1000)
    page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['entries','categories','accounts','settings'],'readwrite'),now=Date.now();
      tx.objectStore('entries').clear();
      const cat=tx.objectStore('categories').get(2);cat.onsuccess=()=>tx.objectStore('categories').put({...cat.result,name:'早餐'});
      tx.objectStore('settings').put({key:'entry.lastUsed',value:{type:'expense',accountId:1,expenseCategoryId:2},updatedAt:now});
      for(let i=0;i<8;i++){
        const lunch=i>=5,at=new Date(now);at.setDate(at.getDate()-i-1);at.setHours(lunch?12:8);
        tx.objectStore('entries').put({id:i+1,type:'expense',amount:1000,categoryId:lunch?3:2,accountId:lunch?2:1,occurredAt:at.getTime(),createdAt:now,updatedAt:now,deletedAt:0,reimburseStatus:'none'});
      }
      await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=()=>j(tx.error)});db.close();
    }''')
    page.reload();page.locator('#fab').click();page.locator('#keypad').wait_for()
    assert '午餐' in page.locator('#cat-grid .cat[aria-selected="true"]').inner_text()
    assert '演示工资卡' in page.locator('#acct-name').inner_text()
    page.locator('#cat-grid .cat').filter(has_text='早餐').click()
    assert '演示现金' in page.locator('#acct-name').inner_text()
    page.locator('#acct-btn').click()
    page.locator('.picker-panel [data-value="2"]').click()
    page.locator('#cat-grid .cat').filter(has_text='午餐').click()
    page.locator('#cat-grid .cat').filter(has_text='早餐').click()
    assert '演示工资卡' in page.locator('#acct-name').inner_text(),'手选账户不得被分类推荐覆盖'

def picker_back(page,width):
    fixture(page);page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-ai-settings"]').click()
    page.locator('#ai-provider').click();page.locator('.picker-panel.open').wait_for();page.wait_for_timeout(300)
    page.go_back();page.wait_for_timeout(450)
    assert page.locator('.picker-mask').count()==0
    assert page.locator('#sp-ai-settings.open').count()==1,'选择器返回不能关闭其所属的设置页'
    assert page.locator('#sp-ai-settings').evaluate('e=>!e.inert&&!e.closest("[inert]")')
    page.go_back();page.wait_for_timeout(450)
    assert page.locator('#sp-ai-settings').count()==0
    expect(page.locator('#page-mine')).to_be_visible()
    expect(page.locator('#page-mine [data-sub="sp-ai-settings"]')).to_be_focused()
    assert page.locator('.viewport').evaluate('e=>!e.inert')

def date_confirm_reopen(page,width):
    fixture(page);open_draft(page)
    page.locator('.dw-confirm').click();page.wait_for_timeout(400)
    page.locator('#date-chip').click();page.locator('.dw-panel.dw-open').wait_for();page.wait_for_timeout(300)
    page.go_back();page.wait_for_timeout(400);check_draft(page)
    page.locator('#sheet-close').click();page.wait_for_timeout(400)
    assert not page.locator('.viewport').evaluate('e=>e.inert')
    # 不得留下空历史层：打开真正的子页后只需一次返回。
    page.locator('#btn-search').click();page.locator('#sp-search.open').wait_for()
    page.go_back();page.wait_for_timeout(450);assert page.locator('#sp-search').count()==0

def account_balances(page,width):
    fixture(page);before=ledger_snapshot(page)
    page.locator('.tab[data-page="page-acct"]').click();page.locator('[data-acct="1"]').click()
    page.locator('#account-months').wait_for();page.wait_for_timeout(400)
    # 虚构流水发生在昨天，月初会落到上月；展开实际所属月份再测可见布局。
    month=page.locator('#account-months .account-month').filter(has=page.locator('[data-eid="1"]'))
    if month.locator('.account-month-head').get_attribute('aria-expanded') != 'true':
        month.locator('.account-month-head').click()
    page.locator('#account-months [data-eid="1"] .account-entry-balance').wait_for(state='visible')
    expected={7:'-48,698.25',6:'-48,758.25',5:'-48,706.25',3:'-48,696.25',2:'-48,638.25',1:'-48,650.25'}
    for ident,amount in expected.items():
        row=page.locator(f'#account-months [data-eid="{ident}"]')
        assert row.locator('.account-entry-balance').count()==1,f'账单 #{ident} 缺少交易后余额'
        assert row.locator('.account-entry-balance').inner_text()==f'余额 {amount}'
        assert row.locator('.account-entry-amounts').evaluate('e=>e.scrollWidth<=e.clientWidth+1'),'完整显示金额和余额'
    # 模拟滚动到流水所在月份，检查最末一笔余额不被固定记账按钮遮住。
    month.evaluate('e=>e.scrollIntoView({block:"start"})')
    page.wait_for_timeout(150)
    last=page.locator('#account-months [data-eid="1"] .account-entry-balance').bounding_box()
    footer=page.locator('#account-detail-entry').bounding_box()
    assert last['y']+last['height'] < footer['y'],'末笔余额滚动后不应被固定按钮遮住'
    page.screenshot(path=str(SHOTS/f'account-running-balance-{width}.png'))
    assert ledger_snapshot(page)==before

def sheet_to_subpage(page,width):
    fixture(page)
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-template-manage"]').click()
    page.locator('#sp-template-manage.open').wait_for()
    page.locator('#tm-add').click();page.locator('#tf-name').wait_for()
    page.locator('#sheet [data-act="close"]').click()
    page.wait_for_timeout(450)
    assert page.locator('#sheet.open').count()==0
    assert page.evaluate('history.state.gleamSubDepth')==1,'关闭模板表单不能吞掉管理页历史'
    assert page.evaluate('!history.state.gleamLayer'),'子页不应继承已关闭弹层标记'
    page.go_back();page.wait_for_timeout(450)
    assert page.locator('#sp-template-manage').count()==0
    assert not page.locator('.viewport').evaluate('e=>e.inert')

def rapid_navigation_back(page,width):
    fixture(page)
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-template-manage"]').wait_for()
    page.evaluate('''()=>{document.querySelector('#page-mine [data-sub="sp-template-manage"]').click();document.dispatchEvent(new CustomEvent('gleam:system-back'))}''')
    page.wait_for_timeout(500)
    assert page.locator('#sp-template-manage').count()==0
    assert page.evaluate('history.state.gleamSubDepth')==0,'已关闭的子页仍被写入空历史层'
    page.locator('#tab-home').click();page.locator('#btn-search').click();page.locator('#sp-search.open').wait_for()
    page.go_back();page.wait_for_timeout(450)
    assert page.locator('#sp-search').count()==0,'空历史层导致后续页面需要多按一次返回'

if __name__=='__main__':
    cases=[(rows,width) for width in (360,390,430,1024)]
    cases += [(account_balances,width) for width in (360,390,430,1024)]
    cases += [(date_tab_order,width) for width in (360,390,430,1024)]
    cases += [(asset_trend,width) for width in (360,390,430,1024)]
    cases += [(concise_copy_and_focus,width) for width in (360,390,430,1024)]
    cases += [(contextual_recommendation,390)]
    cases += [(fn,390) for fn in (browser_date_back,native_date_back,picker_back,date_confirm_reopen,sheet_to_subpage,rapid_navigation_back)]
    if os.environ.get('GLEAM_E2E_CASE'):cases=[(fn,w) for fn,w in cases if fn.__name__==os.environ['GLEAM_E2E_CASE']]
    failures=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        for fn,width in cases:
            context=browser.new_context(viewport={'width':width,'height':844},service_workers='block')
            page=context.new_page();page.set_default_timeout(7000)
            try:
                page.goto(URL);page.wait_for_load_state('networkidle');page.locator('#fab').wait_for()
                fn(page,width);print('PASS',fn.__name__,width,flush=True)
            except Exception as error:
                failures.append(f'{fn.__name__} {width}');print('FAIL',fn.__name__,width,traceback.format_exc(),flush=True)
                page.screenshot(path=str(SHOTS/f'list-back-{fn.__name__}-{width}-fail.png'))
            finally:context.close()
        browser.close()
    raise SystemExit(1 if failures else 0)
