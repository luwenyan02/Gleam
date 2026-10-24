"""Net-worth chart padding and visible small changes with a fictional large balance."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/net-worth-trend'
SEED = '''async () => {
  const db = await new Promise(resolve => {const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
  const tx=db.transaction(['accounts','entries'],'readwrite'), now=new Date();
  tx.objectStore('accounts').clear(); tx.objectStore('entries').clear();
  tx.objectStore('accounts').put({id:1,name:'虚构大额资产',group:'cash',balance:456601894,
    hidden:false,countInNetWorth:true,sortOrder:1,createdAt:1,updatedAt:1});
  for (let i=0;i<6;i++) tx.objectStore('entries').put({id:i+1,type:'income',amount:710278,accountId:1,
    occurredAt:new Date(now.getFullYear(),now.getMonth()-i,1,0).getTime(),
    note:'虚构净资产变化',reimburseStatus:'none',deletedAt:0,createdAt:1,updatedAt:1});
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}'''


def run(browser, width, height, scale, theme):
    context=browser.new_context(viewport={'width':width,'height':height}, timezone_id='Asia/Shanghai',
                                service_workers='block', reduced_motion='reduce')
    page=context.new_page(); errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL); page.locator('#fab').wait_for(); page.evaluate(SEED)
    page.reload(); page.locator('#fab').wait_for()
    page.evaluate('([scale,theme])=>{document.documentElement.style.setProperty("--seed-type",scale);document.documentElement.dataset.theme=theme}',[str(scale),theme])
    page.locator('[data-page="page-acct"]').click()
    page.get_by_role('button', name='显示金额', exact=True).click()
    trend=page.locator('[data-net-trend] .balance-trend')
    expect(trend.locator('.balance-trend-line')).to_have_count(1)
    if not trend.evaluate('el=>el.open'): trend.locator('.balance-trend-heading').click()
    expect(trend.locator('.balance-trend-line')).to_be_visible()
    geometry=trend.evaluate('''el=>{
      const box=node=>node.getBoundingClientRect().toJSON(), hero=el.closest('.acct-hero');
      return {hero:box(hero), heading:box(el.querySelector('summary')),controls:box(el.querySelector('.balance-trend-controls')),
        chart:box(el.querySelector('.balance-trend-chart')),plot:box(el.querySelector('.balance-trend-plot')),
        axis:[...el.querySelectorAll('.balance-trend-axis span')].map(e=>({box:box(e),text:e.textContent,scroll:e.scrollWidth,width:e.clientWidth})),
        buttons:[...el.querySelectorAll('.balance-trend-controls button')].map(box)};
    }''')
    assert geometry['heading']['left']-geometry['hero']['left']>=15, geometry
    assert geometry['hero']['right']-geometry['controls']['right']>=15, geometry
    assert all(b['height']>=44 and b['width']>=44 for b in geometry['buttons']), geometry
    assert geometry['plot']['width']>=120, geometry
    for label in geometry['axis']:
        assert label['scroll']<=label['width']+1, geometry
        assert label['box']['right']<geometry['plot']['left'], geometry
    assert '0' not in [a['text'] for a in geometry['axis']], geometry
    ys=trend.locator('.balance-trend-plot svg').evaluate('''svg=>{
      const path=svg.querySelector('path'), length=path.getTotalLength();
      return Array.from({length:101},(_,i)=>path.getPointAtLength(length*i/100).y);
    }''')
    assert max(ys)-min(ys)>40, ys
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    OUT.mkdir(parents=True,exist_ok=True)
    trend.scroll_into_view_if_needed(); page.screenshot(path=str(OUT/f'{width}-{height}-{scale}-{theme}.png'),animations='disabled')
    # Exact values, month navigation and collapse still work after rescaling.
    trend.locator('.balance-trend-details summary').click()
    expect(trend.locator('.balance-trend-values li')).to_have_count(6)
    expect(trend.locator('.balance-trend-values li').last).to_contain_text('¥4,566,018.94')
    trend.locator('[data-trend-shift="-6"]').click()
    expect(page.locator('[data-net-trend] [data-trend-shift="6"]')).to_be_enabled()
    page.locator('[data-net-trend] [data-trend-shift="6"]').click()
    expect(page.locator('[data-net-trend] [data-trend-shift="6"]')).to_be_disabled()
    page.locator('[data-net-trend] .balance-trend-heading').click()
    expect(page.locator('[data-net-trend] .balance-trend-line')).to_be_hidden()
    assert not errors, errors
    context.close(); print('PASS net worth trend',width,height,scale,theme,flush=True)


if __name__=='__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for profile in [(360,844,1,'light'),(390,844,1,'light'),(430,900,1,'dark'),
                        (400,810,1.3,'light'),(400,810,1.3,'dark'),(1280,900,1,'light')]:
            run(browser,*profile)
        browser.close()
