"""Three-month home window, deliberate one-month pulls and conditional search cards."""
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import expect, sync_playwright

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4602/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/home-monthly-timeline'
SEED = """async startDay => {
  const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
  const names=['entries','accounts','categories','lifeNotes','settings'];
  const tx=db.transaction(names,'readwrite');
  for(const name of names.filter(n=>n!=='settings'))tx.objectStore(name).clear();
  const stamp={createdAt:Date.now(),updatedAt:Date.now()};
  for(const [id,name,group] of [[1,'虚构现金','cash'],[2,'虚构储蓄卡','debit'],[3,'虚构往来','receivable']])
    tx.objectStore('accounts').put({...stamp,id,name,group,balance:100000,hidden:false,countInNetWorth:true,sortOrder:id});
  tx.objectStore('categories').put({...stamp,id:1,name:'餐饮',kind:'expense',icon:'ic-bowl',sortOrder:1});
  tx.objectStore('categories').put({...stamp,id:2,name:'工资',kind:'income',icon:'ic-brief',sortOrder:1});
  const now=new Date(),anchor=new Date(now.getFullYear(),now.getMonth()-(now.getDate()<startDay?1:0),1);
  const months=[];
  for(let p=0;p<7;p++){
    const start=new Date(anchor.getFullYear(),anchor.getMonth()-p,startDay,12);
    months.push(`${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}`);
    for(let j=0;j<20;j++){
      const date=new Date(start);date.setDate(date.getDate()+j);
      const entry={...stamp,id:p*20+j+1,type:'expense',amount:1000,accountId:1,categoryId:1,
        note:j>=10?'虚构常规':'虚构月度资金事件',occurredAt:date.getTime(),deletedAt:0,reimburseStatus:'none'};
      if(j===0)entry.amount=10000;
      if(j===1)Object.assign(entry,{amount:2000,refundFlag:true,refundOfEntryId:p*20+1});
      if(j===2)Object.assign(entry,{amount:-500,sourceAdjustment:{source:'wacai',rowNo:p*20+j+1}});
      if(j===3)Object.assign(entry,{type:'transfer',amount:30000,accountId:undefined,categoryId:undefined,fromAccountId:1,toAccountId:2});
      if(j>=4&&j<=7)Object.assign(entry,{type:'loan',loanKind:['collect','lend','repay','borrow'][j-4],amount:[7000,5000,1000,2000][j-4],accountId:undefined,fromAccountId:[3,1,1,3][j-4],toAccountId:[1,3,3,1][j-4],categoryId:undefined});
      if(j===8)Object.assign(entry,{type:'income',categoryId:2,amount:20000});
      if(j===9)Object.assign(entry,{amount:6000,reimburseStatus:'done',reimbursedAmount:2000,reimburseAccountId:1,reimbursedAt:date.getTime()});
      tx.objectStore('entries').put(entry);
    }
  }
  tx.objectStore('settings').put({key:'accounting.monthStartDay',value:startDay});
  tx.objectStore('settings').put({key:'reimburse.countAsIncome',value:false});
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();return months;
}"""


def count(page, expected):
    expect(page.locator('#hm-days [data-entry-row]')).to_have_count(expected)


def run(browser, width, scale, theme, start_day, date):
    context=browser.new_context(viewport={'width':width,'height':890 if width==400 else 844},device_scale_factor=3 if width==400 else 1,
                                is_mobile=width==400,has_touch=width==400,locale='zh-CN',timezone_id='Asia/Shanghai',service_workers='block',reduced_motion='reduce')
    errors,external=[],[]
    context.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc==urlsplit(URL).netloc else (external.append(r.request.url),r.abort()))
    page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    page.clock.set_fixed_time(datetime.fromisoformat(date));page.goto(URL);page.locator('#fab').wait_for()
    months=page.evaluate(SEED,start_day);page.reload();page.locator('#fab').wait_for()
    page.evaluate('([s,t])=>{document.documentElement.style.setProperty("--seed-type",s);document.documentElement.dataset.theme=t}',[str(scale),theme])
    home=page.locator('#page-home');count(page,60)
    shown=page.locator('#hm-days [data-home-month]').evaluate_all('els=>[...new Set(els.map(e=>e.dataset.homeMonth))]')
    assert shown==months[:3],shown
    home.evaluate('e=>e.scrollTop=e.scrollHeight');page.wait_for_timeout(400);count(page,60)
    home.hover();page.mouse.wheel(0,400);count(page,80)
    for _ in range(5):page.mouse.wheel(0,500)
    page.wait_for_timeout(350);count(page,80)
    home.evaluate('e=>e.scrollTop=e.scrollHeight');page.wait_for_timeout(250);count(page,80)
    page.mouse.wheel(0,300);count(page,100)
    if width==400:
        home.evaluate('e=>e.scrollTop=e.scrollHeight');page.wait_for_timeout(250)
        session=context.new_cdp_session(page);box=home.bounding_box();x=box['x']+box['width']/2;y=box['y']+box['height']-60
        session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
        for delta in [20,40,65,90,120]:
            session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x,'y':y-delta}]});page.wait_for_timeout(20)
        session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]});session.detach();count(page,120)
    target=page.locator(f'#hm-days [data-home-month="{months[1]}"]').first
    target.evaluate('e=>e.scrollIntoView({block:"start"})')
    summary=page.locator('#hm-visible-month')
    expect(summary).to_have_attribute('data-month',months[1])
    expected_top=home.bounding_box()['y']+home.evaluate('e=>parseFloat(getComputedStyle(e).paddingTop)')
    assert abs(summary.bounding_box()['y']-expected_top)<=2
    expense=summary.locator('[data-home-summary="expense"]').inner_text().replace('¥','')
    income=summary.locator('[data-home-summary="income"]').inner_text().replace('¥','')
    before=home.evaluate('e=>e.scrollTop');label=f'{width}-text{scale}-{theme}-day{start_day}'
    page.screenshot(path=str(OUT/f'month-{label}.png'),animations='disabled');summary.click()
    expect(page.locator('#sr-results [data-eid]')).to_have_count(20)
    expect(page.locator('[data-sf="expense"] .sc-amount')).to_have_text(expense)
    expect(page.locator('[data-sf="income"] .sc-amount')).to_have_text(income)
    for key,amount,expected in [('refund','25.00',2),('transfer','300.00',1),('collect','70.00',1)]:
        card=page.locator(f'[data-sf="{key}"]');expect(card.locator('.sc-amount')).to_have_text(amount);card.click()
        expect(card).to_have_attribute('aria-pressed','true');expect(page.locator('#sr-results [data-eid]')).to_have_count(expected)
        expect(card).to_be_in_viewport()
    page.screenshot(path=str(OUT/f'search-{label}.png'),animations='disabled')
    page.locator('#sr-input').fill('虚构常规');expect(page.locator('.sr-summary-card')).to_have_count(3)
    expect(page.locator('#sr-results [data-eid]')).to_have_count(10)
    page.locator('#sp-search .sub-head [data-act="back"]').click();page.locator('#sp-search').wait_for(state='detached')
    assert abs(home.evaluate('e=>e.scrollTop')-before)<2
    count(page,120 if width==400 else 100)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1');assert not errors,errors;assert not external,external
    context.close();print('PASS home monthly loading and search cards',label,flush=True)


def life_only_months(browser):
    context=browser.new_context(viewport={'width':390,'height':844},locale='zh-CN',timezone_id='Asia/Shanghai',service_workers='block')
    page=context.new_page();page.clock.set_fixed_time(datetime.fromisoformat('2026-10-18T12:00:00+08:00'))
    page.goto(URL);page.locator('#fab').wait_for()
    page.evaluate("""async () => {
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction(['entries','lifeNotes','settings'],'readwrite');
      tx.objectStore('entries').clear();tx.objectStore('lifeNotes').clear();
      tx.objectStore('settings').put({key:'accounting.monthStartDay',value:1});
      for(let id=1;id<=12;id++)tx.objectStore('lifeNotes').put({id,kind:'diary',title:'虚构六月生活记录',body:'只含生活记录的历史月份',occurredAt:new Date(2026,5,15,12).getTime(),createdAt:1,updatedAt:1,deletedAt:0});
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
    }""")
    page.reload();page.locator('#fab').wait_for()
    expect(page.locator('#hm-days [data-home-month]')).to_have_count(3)
    expect(page.locator('#hm-more')).to_have_text('再上拉加载2026年7月')
    page.locator('#hm-more').click()
    expect(page.locator('#hm-days [data-home-month]')).to_have_count(4)
    expect(page.locator('#hm-more')).to_have_text('再上拉加载2026年6月')
    expect(page.locator('#hm-days')).not_to_contain_text('虚构六月生活记录')
    page.locator('#hm-more').click()
    expect(page.locator('#hm-days [data-home-month]')).to_have_count(5)
    expect(page.locator('#hm-days')).to_contain_text('虚构六月生活记录')
    expect(page.locator('#hm-more')).to_have_text('已展示全部流水')
    expect(page.locator('#hm-more')).to_be_disabled()
    count(page,0)
    page.locator('[data-home-month="2026-06"]').evaluate('e=>e.scrollIntoView({block:"start"})')
    expect(page.locator('#hm-visible-month')).to_have_attribute('data-month','2026-06')
    expect(page.locator('[data-home-summary="expense"]')).to_have_text('¥0.00')
    page.locator('#hm-visible-month').click()
    expect(page.locator('#sr-results [data-eid]')).to_have_count(0)
    expect(page.locator('.sr-summary-card')).to_have_count(3)
    context.close();print('PASS empty months, life-only history and exhaustion',flush=True)


if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        b=p.chromium.launch()
        for width,scale,theme,start_day,date in [(400,1,'light',1,'2026-10-18T12:00:00+08:00'),(400,1.3,'dark',5,'2026-10-18T12:00:00+08:00'),
            (360,1,'light',28,'2026-01-15T12:00:00+08:00'),(390,1,'dark',1,'2026-10-18T12:00:00+08:00'),(430,1,'light',5,'2026-10-18T12:00:00+08:00'),(1280,1,'dark',1,'2026-10-18T12:00:00+08:00')]:
            run(b,width,scale,theme,start_day,date)
        life_only_months(b)
        b.close()
