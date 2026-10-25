"""Inbox/category entry performance and cancellation with a fictional long-lived ledger."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from test_mine_performance import SEED
from test_page_open_performance import AUDIT, MEASURE

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/inbox-category-performance'


def run(browser, width, theme):
    context = browser.new_context(viewport={'width': width, 'height': 890}, device_scale_factor=3 if width == 400 else 1,
                                  timezone_id='Asia/Shanghai', service_workers='block')
    context.add_init_script(AUDIT)
    external = []
    context.route('**/*', lambda r: r.continue_() if urlsplit(r.request.url).netloc == urlsplit(URL).netloc else (external.append(1), r.abort()))
    page = context.new_page(); errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL); page.locator('#fab').wait_for(); page.evaluate(SEED, 5000)
    page.reload(); page.locator('#fab').wait_for()
    page.evaluate('(theme)=>document.documentElement.dataset.theme=theme', theme)
    session = context.new_cdp_session(page); session.send('Emulation.setCPUThrottlingRate', {'rate': 4})
    page.evaluate(MEASURE, {'selector': None, 'target': '#hm-days'})
    results = {}

    def measure(name, selector, target):
        result = page.evaluate(MEASURE, {'selector': selector, 'target': target})
        results[name] = result
        (OUT / f'{width}-{theme}.json').write_text(json.dumps(results, indent=2))
        print('METRIC', name, result['shell_ms'], result['ready_ms'], flush=True)
        return result

    def close():
        page.locator('.subpage.open').last.locator('.sub-head [data-act="back"]').click()
        page.locator('.subpage').wait_for(state='detached')
        page.evaluate(MEASURE, {'selector': None, 'target': '#page-mine'})

    def entry_values(result):
        return sum(n for k, n in result['rows'].items() if k.startswith('entries:') and k.split(':')[-1] in ['get', 'getAll', 'openCursor'])

    measure('mine', '[data-page="page-mine"]', '#page-mine')
    expect(page.locator('[data-mine-stats]')).to_contain_text('20000 条流水')
    inbox = measure('inbox', '#page-mine [data-sub="sp-ai-inbox"]', '#sp-ai-inbox .ai-input')
    assert entry_values(inbox) == 0, inbox
    assert sum(n for k, n in inbox['requests'].items() if k.startswith('accounts:')) == 1, inbox
    assert inbox['ready_ms'] < 1500, inbox
    page.locator('#ai-text').fill('虚构草稿：午餐 28 元')
    page.screenshot(path=str(OUT / f'inbox-{width}-{theme}.png'), animations='disabled')
    close()
    categories = measure('categories', '#page-mine [data-sub="sp-categories"]', '#cm-list .cm-item')
    assert entry_values(categories) == 0, categories
    counts = page.locator('[data-category-count]').all_text_contents()
    assert counts and all('—' not in c for c in counts)
    tab = measure('category-income', '#cm-seg [data-t="income"]', '#cm-list')
    assert not any(k.startswith('entries:') for k in tab['requests']), tab
    measure('category-expense', '#cm-seg [data-t="expense"]', '#cm-list')
    assert counts == page.locator('[data-category-count]').all_text_contents()
    page.screenshot(path=str(OUT / f'categories-{width}-{theme}.png'), animations='disabled')
    close()
    page.locator('#tab-home').click()
    page.evaluate(MEASURE, {'selector': None, 'target': '#hm-days'})
    immediate = MEASURE.replace('b.click();', 'b.click();document.querySelector(\'#page-mine [data-sub="sp-ai-inbox"]\').click();')
    result = page.evaluate(immediate, {'selector': '[data-page="page-mine"]', 'target': '#sp-ai-inbox .ai-input'})
    results['immediate-inbox'] = result
    keys = sum(n for k, n in result['rows'].items() if k.startswith('entries:') and 'openKeyCursor' in k)
    assert keys < 100, result  # Hidden Mine must stop, not finish scanning 5000 dates behind Inbox.
    # Wall time includes the Home-to-Mine transition and varies with shared CI CPU.
    # The strict regression guard is the stopped cursor above (under 100 vs 5000 dates).
    assert result['ready_ms'] < 5000, result
    close()
    expect(page.locator('[data-mine-stats]')).to_contain_text('20000 条流水')
    # Nonempty recent batches: only the newest three AI batches, including soft deletions.
    page.evaluate(r'''async()=>{
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction(['entries','importBatches'],'readwrite'),entries=tx.objectStore('entries');
      for(let i=1;i<=4;i++){
        tx.objectStore('importBatches').put({id:200+i,source:'ai',fileName:'虚构AI入账',createdAt:i,updatedAt:i,counts:{expense:i===4?2:1}});
        const req=entries.get(i);req.onsuccess=()=>entries.put({...req.result,importBatchId:200+i});
      }
      const req=entries.get(5);req.onsuccess=()=>entries.put({...req.result,importBatchId:204,deletedAt:1});
      tx.objectStore('importBatches').put({id:999,source:'alipay',fileName:'虚构普通导入',createdAt:99,updatedAt:99,counts:{expense:1}});
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
    }''')
    batches = measure('recent-batches', '#page-mine [data-sub="sp-ai-inbox"]', '#sp-ai-inbox .ai-input')
    assert entry_values(batches) <= 4, batches
    assert page.locator('[data-undo]').evaluate_all('(els)=>els.map(e=>e.dataset.undo)') == ['204', '203', '202']
    expect(page.locator('[aria-label="最近 AI 入账"]')).to_contain_text('1 笔已撤')
    page.locator('#ai-text').fill('保留的虚构草稿')
    page.locator('[data-undo="204"]').click()
    expect(page.locator('[data-undo="204"]')).to_have_count(0)
    expect(page.locator('#ai-text')).to_have_value('保留的虚构草稿')
    expect(page.locator('[data-undo]')).to_have_count(2)
    assert not errors and not external, (errors, external)
    (OUT / f'{width}-{theme}.json').write_text(json.dumps(results, indent=2))
    context.close()
    print('PASS inbox/category bounded reads, tab reuse and hidden Mine cancellation', width, theme, flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width, theme in [(400, 'light')]:
            run(browser, width, theme)
        browser.close()
