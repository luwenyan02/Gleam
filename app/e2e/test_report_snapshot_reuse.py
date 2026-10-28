"""报表同周期切维度复用完整结果；变更、日期及重新进入读取最新数据。仅虚构账目。"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect
from test_page_open_performance import AUDIT, MEASURE, SEED

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/report-snapshot-reuse'


def run(browser):
    context = browser.new_context(viewport={'width': 400, 'height': 890}, device_scale_factor=3,
        timezone_id='Asia/Shanghai', locale='zh-CN', service_workers='block', reduced_motion='reduce')
    context.add_init_script(AUDIT)
    external = []
    context.route('**/*', lambda route: route.continue_() if urlsplit(route.request.url).netloc == urlsplit(URL).netloc
        else (external.append(route.request.resource_type), route.abort()))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.set_fixed_time(datetime(2026, 10, 28, 4, tzinfo=timezone.utc))
    page.goto(URL)
    page.locator('#fab').wait_for()
    page.evaluate(SEED.replace('Math.min(2400,count)', '0'), 2500)
    page.reload()
    page.locator('#fab').wait_for()
    page.evaluate(MEASURE, {'selector': None, 'target': '#hm-days'})
    measurements = {}

    def measure(name, selector):
        # Yield after clicks so synchronous paints and their MutationObserver are counted.
        result = page.evaluate(MEASURE.replace('const deadline=', 'await new Promise(r=>requestAnimationFrame(r));const deadline='),
            {'selector': selector, 'target': '#page-report'})
        result['entry_reads'] = sum(n for key, n in result['rows'].items()
            if key.startswith('entries:') and key.endswith(('get', 'getAll', 'openCursor')))
        measurements[name] = result
        return result

    measure('open-month', '[data-page="page-report"]')
    year = measure('open-year', '#r-seg [data-p="year"]')
    assert year['entry_reads'] > 0, year
    expected = page.locator('.r-sum').inner_text()
    for dimension in ('category', 'account', 'tag', 'income', 'merchant', 'trend'):
        result = measure(dimension, f'#report-dim [data-dimension="{dimension}"]')
        assert result['entry_reads'] == 0, (dimension, result)
        assert page.locator('.r-sum').inner_text() == expected
        expect(page.locator(f'#report-dim [data-dimension="{dimension}"]')).to_have_attribute('aria-selected', 'true')

    measure('account-again', '#report-dim [data-dimension="account"]')
    initial = page.locator('#rank li').count()
    expect(page.locator('#rank-more')).to_be_visible()
    expanded = measure('expand', '#rank-more')
    assert expanded['entry_reads'] == 0, expanded
    assert page.locator('#rank li').count() > initial
    collapsed = measure('collapse', '#rank-more')
    assert collapsed['entry_reads'] == 0, collapsed
    assert page.locator('#rank li').count() == initial

    # Clicking dimensions while a period is loading must share that load, not launch more.
    page.evaluate('''()=>{
      window.__nav={rows:{},requests:{},active:true,start:performance.now()};
      document.querySelector('#page-report [data-nav="-1"]').click();
      document.querySelector('#report-dim [data-dimension="tag"]').click();
      document.querySelector('#report-dim [data-dimension="merchant"]').click();
    }''')
    race = page.evaluate(MEASURE, {'selector': None, 'target': '#page-report', 'reset': False})
    reads = sum(n for key, n in race['rows'].items() if key.startswith('entries:') and key.endswith(('get', 'getAll', 'openCursor')))
    expect(page.locator('#r-label')).to_have_text('2025年')
    expect(page.locator('#rank-title')).to_have_text('商家排行')
    assert 0 < reads <= 1300, race  # One selected year, not three duplicate reads.
    measurements['period-race'] = race
    changed = measure('next-year', '#page-report [data-nav="1"]')
    assert changed['entry_reads'] > 0, changed
    assert page.locator('.r-sum').inner_text() == expected

    # An independent DB connection can write without the in-process event bus.
    before = int(round(float(page.locator('#r-spend').inner_text().replace('¥', '').replace(',', '')) * 100))
    page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['entries','accounts'],'readwrite');
      const e=tx.objectStore('entries').get(1);e.onsuccess=()=>tx.objectStore('entries').put({...e.result,amount:e.result.amount+1234,updatedAt:Date.now()});
      const a=tx.objectStore('accounts').get(201);a.onsuccess=()=>tx.objectStore('accounts').put({...a.result,name:'虚构账户已更新',updatedAt:Date.now()});
      await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error)});db.close();
    }''')
    page.locator('[data-page="page-home"]').click()
    page.evaluate(MEASURE, {'selector': None, 'target': '#hm-days'})
    reentry = measure('reenter', '[data-page="page-report"]')
    assert reentry['entry_reads'] > 0, reentry
    after = int(round(float(page.locator('#r-spend').inner_text().replace('¥', '').replace(',', '')) * 100))
    assert after == before + 1234, (before, after)
    measure('account-renamed', '#report-dim [data-dimension="account"]')
    measure('expand-renamed', '#rank-more')
    expect(page.locator('#rank')).to_contain_text('虚构账户已更新')

    page.locator('[data-summary-type="expense"]').click()
    page.locator('#sr-results [data-eid]').first.wait_for()
    page.locator('#sp-search .sub-head [data-act="back"]').click()
    page.locator('#sp-search').wait_for(state='detached')
    page.evaluate(MEASURE, {'selector': None, 'target': '#page-report'})
    assert page.locator('#r-spend').inner_text() == '¥' + f'{after/100:,.2f}'
    assert measure('after-reveal-dimension', '#report-dim [data-dimension="category"]')['entry_reads'] == 0

    # Competing period requests must not paint an old period over the final selection.
    page.evaluate('''()=>{
      document.querySelector('#page-report [data-nav="-1"]').click();
      document.querySelector('#page-report [data-nav="1"]').click();
      document.querySelector('#report-dim [data-dimension="income"]').click();
    }''')
    page.evaluate(MEASURE, {'selector': None, 'target': '#page-report'})
    expect(page.locator('#r-label')).to_have_text('2026年')
    expect(page.locator('#rank-title')).to_have_text('收入分类')
    assert page.locator('#r-spend').inner_text() == '¥' + f'{after/100:,.2f}'

    # A failed read cannot leave the view permanently waiting on a stale loading token.
    page.evaluate('''()=>{
      const original=IDBIndex.prototype.getAll;
      IDBIndex.prototype.getAll=function(...args){
        if(this.objectStore.name==='entries'){
          IDBIndex.prototype.getAll=original;
          throw new DOMException('Synthetic one-shot report read failure','UnknownError');
        }
        return original.apply(this,args);
      };
      document.querySelector('#page-report [data-nav="-1"]').click();
    }''')
    expect(page.locator('#toast')).to_contain_text('报表暂时加载失败')
    retry = measure('retry-read', '#report-dim [data-dimension="category"]')
    assert retry['entry_reads'] > 0, retry
    expect(page.locator('#r-label')).to_have_text('2025年')
    page.locator('#toast.show').wait_for(state='hidden')
    page.screenshot(path=str(OUT / 'xiaomi14-report.png'), animations='disabled')
    assert not errors and not external, (errors, external)
    (OUT / 'metrics.json').write_text(json.dumps(measurements, ensure_ascii=False, indent=2))
    context.close()
    print('PASS report snapshot reuse, in-flight switch, period invalidation, cross-connection reentry and drilldown return', flush=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            run(browser)
        finally:
            browser.close()


if __name__ == '__main__':
    main()
