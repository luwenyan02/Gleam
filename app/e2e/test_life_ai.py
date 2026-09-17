"""生活 AI：所有数据虚构；外部 AI 请求均由测试拦截。"""
import os
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from test_acceptance_fixes import seed
from test_entry_receipts import image
from test_m3 import do_backup, do_restore, open_backup
from test_save_atomic import fail_once

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/life-ai'

def read_rows(page, table):
    return page.evaluate('''table => new Promise((resolve, reject) => {
      const request = indexedDB.open('GleamDB');
      request.onsuccess = () => { const db = request.result; const r = db.transaction(table).objectStore(table).getAll();
        r.onsuccess = () => { resolve(JSON.parse(JSON.stringify(r.result))); db.close(); }; r.onerror = () => reject(r.error); };
    })''', table)

def configure(page):
    page.evaluate('''async () => {
      sessionStorage.setItem('gleam-secret:ai.apiKey', 'synthetic-test-key');
      const db = await new Promise(resolve => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction(['settings','lifeNotes'], 'readwrite');
      for (const [key,value] of [['ai.baseUrl','https://life-ai.invalid/v1'], ['ai.model','test-model']]) tx.objectStore('settings').put({key,value});
      const d = new Date(); d.setHours(12,0,0,0); d.setDate(d.getDate() - (d.getDay()+6)%7 - 7);
      for (const [id,body,aiExcluded] of [[900001,'虚构周末散步，看见橘猫。',false], [900002,'不能发送的私人内容',true], [900003,'没有勾选的另一个故事',false]]) {
        tx.objectStore('lifeNotes').put({id,kind:'diary',body,aiExcluded,occurredAt:d.getTime(),createdAt:1,updatedAt:1,deletedAt:0});
      }
      await new Promise((resolve,reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    }''')

def screenshot(page, name, width, selector):
    page.locator('#toast.show').wait_for(state='hidden')
    page.wait_for_timeout(350)
    assert page.locator(selector).evaluate('el => el.scrollWidth <= el.clientWidth + 1'), name
    tiny = page.locator(f'{selector} button').evaluate_all('''els => els.filter(el => {
      const r = el.getBoundingClientRect(); return !el.closest('[hidden]') && r.width > 0 && (r.width < 43 || r.height < 43);
    }).map(el => el.textContent)''')
    assert not tiny, tiny
    page.screenshot(path=str(OUT / f'{name}-{width}.png'), animations='disabled')

def upload_photo(page, payload):
    input_el = page.locator('#lc-file')
    input_el.set_input_files(payload)
    page.wait_for_function("""() => document.querySelector('#lc-photos img') ||
      document.querySelector('#lc-status')?.textContent?.trim()""")
    assert page.locator('#lc-photos img').count() == 1, page.locator('#lc-status').inner_text()

def open_capture(page):
    page.locator('[data-life-capture]').click()
    page.locator('#sheet.open').wait_for()

def run(page, width):
    errors, requests = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda req: requests.append(req.url) if '/chat/completions' in req.url else None)
    page.goto(URL); page.locator('#fab').wait_for()
    page.locator('[data-page="page-life"]').click()
    open_capture(page)
    page.locator('#lc-body').fill('虚构随记：阳台的一小块阳光。')
    fail_once(page, 'lifeDrafts')
    page.locator('[data-lc-close]').click()
    open_capture(page)
    assert page.locator('#lc-body').input_value() == '虚构随记：阳台的一小块阳光。'
    page.locator('[data-lc-save]').click()
    page.locator('#sheet.open').wait_for(state='hidden')
    assert '阳台的一小块阳光' in page.locator('#lf-feed').inner_text()
    assert not requests, '普通保存不得调用 AI'
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / f'life-{width}.png'), animations='disabled')
    configure(page)
    payloads = []
    mode = ['ask']
    def mock(route):
        payload = route.request.post_data_json
        payloads.append(payload)
        if mode[0] == 'fail':
            route.fulfill(status=500, body='private provider text must not show'); return
        answer = {'ask':'哪一个小细节让你想留下这一刻？', 'organize':'阳台上的阳光，和一杯热茶。',
                  'week':json.dumps({'title':'橘猫经过的一周', 'blocks':[{'noteId':900001,'text':'散步时，看见了一只橘猫。'}]},ensure_ascii=False)}[mode[0]]
        route.fulfill(json={'choices':[{'message':{'content':answer}}]})
    page.route('https://life-ai.invalid/**', mock)
    open_capture(page)
    page.locator('#lc-body').fill('阳台上的阳光。')
    upload_photo(page, image(page, '虚构生活照.png', '#cfa66e'))
    assert page.locator('#lc-photos').evaluate('el => el.getBoundingClientRect().height >= 80'), '照片预览不得被弹层挤没'
    assert not page.locator('#lc-send-images').is_checked()
    page.locator('[data-lc-ask]').click()
    page.locator('#dialog-scrim [data-act="cancel"]').click()
    assert not payloads
    page.locator('[data-lc-ask]').click()
    page.locator('#dialog-scrim.show').wait_for()
    assert '阳台上的阳光' in page.locator('#dialog-scrim').inner_text()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('#lc-reply').wait_for(state='visible')
    assert len(payloads) == 1
    assert 'image_url' not in json.dumps(payloads[-1])
    assert '不能发送' not in json.dumps(payloads,ensure_ascii=False)
    page.locator('#lc-reply').fill('还有一杯热茶。')
    page.locator('#lc-send-images').check()
    mode[0] = 'organize'
    page.locator('[data-lc-organize]').click()
    page.locator('#dialog-scrim.show').wait_for()
    assert '热茶' in page.locator('#dialog-scrim').inner_text()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('#lc-ai-text').wait_for()
    assert '热茶' in page.locator('#lc-ai-text').input_value()
    assert 'image_url' in json.dumps(payloads[-1])
    screenshot(page, 'composer', width, '#sheet')
    page.locator('#lc-ai-text').scroll_into_view_if_needed()
    screenshot(page, 'composer-preview', width, '#sheet')
    page.locator('[data-lc-save]').click()
    page.locator('#sheet.open').wait_for(state='hidden')
    notes = read_rows(page, 'lifeNotes')
    saved = next(n for n in notes if (n.get('originalBody') or '').startswith('阳台'))
    assert saved['originalBody'] == '阳台上的阳光。\n\n还有一杯热茶。'
    assert saved['body'] == '阳台上的阳光，和一杯热茶。'

    open_capture(page)
    upload_photo(page, image(page, '虚构纯照片.png', '#cfa66e'))
    page.locator('#lc-send-images').check()
    page.locator('[data-lc-organize]').click(); page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('#lc-ai-text').wait_for()
    page.locator('[data-lc-remove]').click()
    page.locator('#lc-ai-text').wait_for(state='detached')
    assert '旧的 AI 提问和整理稿已移除' in page.locator('#lc-status').inner_text()
    upload_photo(page, image(page, '虚构纯照片-重选.png', '#b99361'))
    page.locator('#lc-send-images').check()
    page.locator('[data-lc-organize]').click(); page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('#lc-ai-text').wait_for()
    page.locator('[data-lc-save]').click(); page.locator('#sheet.open').wait_for(state='hidden')
    photo_note = next(n for n in read_rows(page,'lifeNotes') if n.get('originalBody') == '')
    page.locator(f'[data-note="{photo_note["id"]}"]').click()
    assert page.locator('#lc-body').input_value() == ''
    assert page.locator('#lc-ai-text').input_value() == photo_note['body']
    page.locator('[data-lc-save]').click(); page.locator('#sheet.open').wait_for(state='hidden')
    assert next(n for n in read_rows(page,'lifeNotes') if n['id'] == photo_note['id'])['body'] == photo_note['body']

    mode[0] = 'fail'
    open_capture(page)
    page.locator('#lc-body').fill('失败也不能丢掉的虚构原话')
    page.locator('[data-lc-ask]').click(); page.locator('#dialog-scrim [data-act="ok"]').click()
    page.wait_for_function("document.querySelector('#lc-status').textContent.includes('不可用') || document.querySelector('#lc-status').textContent.includes('错误')")
    assert 'private provider' not in page.locator('#sheet').inner_text()
    page.locator('[data-lc-close]').click(); open_capture(page)
    assert page.locator('#lc-body').input_value() == '失败也不能丢掉的虚构原话'
    page.locator('[data-lc-close]').click()

    page.locator('[data-life-edition]').click()
    page.locator('[data-le-source="900001"]').wait_for()
    assert page.locator('[data-le-source="900002"]').count() == 0
    page.locator('[data-le-source="900003"]').uncheck()
    mode[0] = 'week'
    screenshot(page, 'week-sources', width, '#sp-life-edition')
    page.locator('[data-le-generate]').click()
    page.locator('#dialog-scrim.show').wait_for()
    assert '没有勾选' not in page.locator('#dialog-scrim').inner_text()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('#le-title').wait_for()
    assert '没有勾选' not in json.dumps(payloads[-1],ensure_ascii=False)
    assert read_rows(page,'lifeEditions') == [], '预览不能自动收藏'
    page.locator('#le-title').fill('我的橘猫小报')
    page.locator('[data-le-save]').click()
    page.locator('[data-le-edit]').wait_for()
    assert len(read_rows(page,'lifeEditions')) == 1
    screenshot(page, 'weekly-paper', width, '#sp-life-edition')
    page.locator('[data-le-view]').click()
    page.locator('summary').filter(has_text='标题与更多').click()
    page.locator('#lc-exclude').check()
    page.locator('[data-lc-save]').click()
    page.locator('#sheet.open').wait_for(state='hidden')
    page.get_by_text('这期暂不展示', exact=True).wait_for()
    assert '我的橘猫小报' not in page.locator('#le-content').inner_text()
    assert '散步时，看见' not in page.locator('#le-content').inner_text()
    screenshot(page, 'weekly-private', width, '#sp-life-edition')
    seed(page, count=1, amount=1200)
    before = read_rows(page, 'accounts')[0]['balance']
    page.locator('[data-entry]').first.click()
    page.locator('[data-entry-life]').click()
    page.locator('.picker-item[data-value="new"]').click()
    page.locator('#lc-body').fill('虚构体验：这顿饭留下了一个好故事。')
    page.locator('summary').filter(has_text='后来怎么样').click()
    page.locator('#lc-verdict').select_option('again')
    page.locator('#lc-review').fill('下次还想来。')
    screenshot(page, 'entry-story', width, '#sheet')
    page.locator('[data-lc-save]').click(); page.locator('#sheet.open').wait_for(state='hidden')
    entry = read_rows(page,'entries')[0]
    assert entry['lifeNoteId'] and entry['amount'] == 1200
    assert read_rows(page,'accounts')[0]['balance'] == before
    assert len(read_rows(page,'entries')) == 1
    page.locator('[data-entry-life]').click()
    page.locator('summary').filter(has_text='关联原账单').click()
    assert '12.00' in page.locator('#lc-linked-entries').inner_text()
    page.locator('[data-lc-close]').click()
    page.evaluate('''async id => {
      const db = await new Promise(resolve => { const r=indexedDB.open('GleamDB'); r.onsuccess=()=>resolve(r.result); });
      const tx=db.transaction('lifeNotes','readwrite'), store=tx.objectStore('lifeNotes'), r=store.get(id);
      r.onsuccess=()=>store.put({...r.result,review:{...r.result.review,revisitAt:Date.now()-86400000}});
      await new Promise(resolve=>tx.oncomplete=resolve); db.close();
    }''',entry['lifeNoteId'])
    page.reload(); page.locator('#fab').wait_for(); page.locator('[data-page="page-life"]').click()
    page.locator('[data-revisit-dismiss]').wait_for()
    screenshot(page,'revisit',width,'#page-life')
    page.locator('[data-revisit-dismiss]').click()
    page.locator('[data-revisit-dismiss]').wait_for(state='detached')
    assert next(n for n in read_rows(page,'lifeNotes') if n['id'] == entry['lifeNoteId'])['review']['dismissedAt'] > 0
    if width == 390:
        page.reload(); page.locator('#fab').wait_for(); open_backup(page)
        for password in (None, 'fiction-life-passphrase'):
            before = {table: read_rows(page,table) for table in ('lifeNotes','lifeDrafts','lifeEditions')}
            backup = do_backup(page,password=password)
            do_restore(page,backup,password=password)
            assert {table: read_rows(page,table) for table in before} == before
            setting = next(row for row in read_rows(page,'settings') if row['key'] == 'life.aiEnabled')
            assert setting['value'] is False
    assert not errors, errors

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            for width in (360, 390, 430, 1280):
                context = browser.new_context(viewport={'width':width,'height':900}, service_workers='block')
                try:
                    page=context.new_page(); page.set_default_timeout(7000)
                    run(page,width); print('PASS life AI',width,flush=True)
                except Exception:
                    page.screenshot(path=str(OUT / f'failure-{width}.png'))
                    print(page.locator('body').inner_text()[-4000:],flush=True)
                    raise
                finally: context.close()
        finally: browser.close()
