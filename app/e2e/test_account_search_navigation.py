"""Account-scoped search, bottom navigation and entry header; fictional records only."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_search_filter_groups import URL, SEED, results, confirm
from test_browser_usability import assert_usable

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/account-search-navigation'
EXTRA = """async()=>{
 const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
 const tx=db.transaction(['entries','lifeNotes'],'readwrite'), stamp={createdAt:1,updatedAt:1,deletedAt:0,reimburseStatus:'none'};
 for(const [id,fromAccountId,toAccountId,type]of [[7,9002,9001,'transfer'],[8,9001,9002,'transfer'],[9,9001,9004,'loan']])
 tx.objectStore('entries').put({...stamp,id,fromAccountId,toAccountId,type,loanKind:'lend',amount:100,occurredAt:Date.now(),note:'虚构共同'});
 tx.objectStore('entries').put({...stamp,id:10,type:'expense',categoryId:8002,accountId:9001,amount:222,
  occurredAt:new Date(2022,0,1).getTime(),note:'虚构共同历史'});
 tx.objectStore('entries').put({...stamp,id:11,type:'expense',categoryId:8002,accountId:9002,amount:333,
  occurredAt:Date.now(),note:'虚构共同其他账户'});
 tx.objectStore('entries').put({...stamp,id:12,type:'expense',categoryId:8002,accountId:9001,amount:444,
  occurredAt:Date.now(),note:'虚构共同已删除',deletedAt:1});
 tx.objectStore('lifeNotes').put({...stamp,id:500,kind:'diary',title:'虚构共同生活',body:'不应出现在账户账单',occurredAt:Date.now()});
 await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=()=>j(tx.error)});db.close();
}"""


def run(browser, width, theme, scale):
    context=browser.new_context(viewport={'width':width,'height':844},timezone_id='Asia/Shanghai',
                                service_workers='block',reduced_motion='reduce')
    page=context.new_page(); errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(URL);page.locator('#fab').wait_for();page.evaluate(SEED);page.evaluate(EXTRA);page.reload();page.locator('#fab').wait_for()
    page.evaluate('([s,t])=>{document.documentElement.style.setProperty("--seed-type",s);document.documentElement.dataset.theme=t}',[str(scale),theme])
    page.locator('[data-page="page-acct"]').click();page.locator('[data-acct="9001"]').click()
    search=page.locator('#account-detail-search')
    expect(search).to_be_visible(timeout=2000);expect(search).to_be_enabled()
    assert search.evaluate('e=>{const b=e.getBoundingClientRect();return b.width>=44&&b.height>=44}')
    OUT.mkdir(parents=True,exist_ok=True)
    page.screenshot(path=str(OUT/f'account-{width}-{theme}-{scale}.png'),animations='disabled')
    body=page.locator('#sp-account-detail .sub-body');body.evaluate('e=>e.scrollTop=200')
    scroll=body.evaluate('e=>e.scrollTop')
    search.click();results(page,[1,6,7,8,9,10])
    expect(page.locator('#sp-search .sub-head h2')).to_contain_text('虚构现金一')
    expect(page.locator('#sr-active-filters [data-remove-filter="account"]')).to_have_count(0)
    page.locator('#sr-input').fill('虚构共同');results(page,[7,8,9,10])
    expect(page.locator('#sr-results [data-nid]')).to_have_count(0)
    page.locator('#sr-adv-filter').click()
    expect(page.locator('.fp-panel [data-expand="account"]')).to_have_count(0)
    page.locator('.fp-panel [data-expand="category"]').click();page.locator('.fp-panel [data-cid="8002"]').click();confirm(page)
    results(page,[10]);page.locator('#sr-adv-filter').click();page.locator('.fp-reset').click();confirm(page);results(page,[7,8,9,10])
    page.locator('#sr-input').fill('不存在的虚构文字');results(page,[])
    expect(page.locator('#sr-results .sr-empty')).to_be_visible()
    page.locator('#sr-clear-input').click();results(page,[1,6,7,8,9,10])
    page.screenshot(path=str(OUT/f'search-{width}-{theme}-{scale}.png'),animations='disabled')
    page.go_back();page.locator('#sp-search').wait_for(state='detached');expect(page.locator('#sp-account-detail')).to_be_visible();expect(search).to_be_focused()
    assert abs(body.evaluate('e=>e.scrollTop')-scroll)<2
    search.click();results(page,[1,6,7,8,9,10]);page.locator('#sr-cancel-btn').click();page.locator('#sp-search').wait_for(state='detached')
    page.locator('#sp-account-detail [data-act="back"]').click();page.locator('#sp-account-detail').wait_for(state='detached')
    page.locator('[data-acct="9003"]').click();search.click();results(page,[3,5]);page.go_back();page.locator('#sp-search').wait_for(state='detached')
    page.locator('#sp-account-detail [data-act="back"]').click();page.locator('#sp-account-detail').wait_for(state='detached');page.locator('#tab-home').click()
    page.locator('#btn-search').click()
    page.locator('#sr-input').fill('虚构共同');results(page,[7,8,9,10,11])
    expect(page.locator('#sr-results [data-nid="500"]')).to_be_visible();page.go_back();page.locator('#sp-search').wait_for(state='detached')
    page.locator('[data-page="page-report"]').click()
    order=page.locator('.tabbar > button:visible').evaluate_all('es=>es.map(e=>e.id||e.dataset.page)')
    assert order==['page-report','page-acct','tab-home','page-life','page-mine'],order
    page.locator('[data-page="page-report"]').click();expect(page.locator('#page-report')).to_be_visible()
    page.locator('#tab-home').click();page.locator('#fab').click();page.locator('#keypad').wait_for()
    expect(page.locator('#btn-voice')).to_have_count(0);expect(page.locator('#sheet-close')).to_have_text('关闭')
    for kind in ['income','transfer','loan','expense']:
        page.locator(f'#seg [data-type="{kind}"]').click()
        assert_usable(page,'#sheet .sheet-head')
    close=page.locator('#sheet-close')
    assert close.evaluate('e=>{const b=e.getBoundingClientRect();return b.width>=44&&b.height>=44}')
    page.screenshot(path=str(OUT/f'entry-{width}-{theme}-{scale}.png'),animations='disabled')
    close.click();expect(page.locator('#sheet.open')).to_have_count(0);expect(page.locator('#fab')).to_be_focused()
    assert not errors,errors
    context.close();print('PASS account search, tabs, entry header',width,theme,scale,flush=True)


if __name__=='__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for profile in [(360,'light',1),(390,'light',1),(430,'dark',1),(360,'light',1.3),(400,'dark',1.3),(1280,'light',1)]:
            run(browser,*profile)
        browser.close()
