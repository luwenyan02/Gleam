"""生活 AI 对话验收：所有数据均为虚构，外部请求由本地 mock 拦截。"""
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright
from test_entry_receipts import image

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
      const tx = db.transaction('settings', 'readwrite');
      for (const [key,value] of [['ai.baseUrl','https://life-ai.invalid/v1'], ['ai.model','test-model'], ['life.aiEnabled',false]]) tx.objectStore('settings').put({key,value});
      await new Promise((resolve,reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    }''')


def screenshot(page, name, width, selector):
    page.locator('#toast.show').wait_for(state='hidden')
    page.wait_for_timeout(300)
    target = page.locator(selector)
    assert target.evaluate('el => el.scrollWidth <= el.clientWidth + 1'), name
    tiny = target.locator('button').evaluate_all('''els => els.filter(el => {
      const r = el.getBoundingClientRect(); return !el.closest('[hidden]') && r.width > 0 && (r.width < 43 || r.height < 43);
    }).map(el => el.textContent)''')
    assert not tiny, tiny
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.screenshot(path=str(OUT / f'{name}-{width}.png'), animations='disabled')


def open_life(page):
    page.goto(URL)
    page.locator('#fab').wait_for()
    page.locator('[data-page="page-life"]').click()
    page.locator('[data-life-capture]').wait_for()


def run(page, width):
    errors, requests, payloads = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda req: requests.append(req.url) if '/chat/completions' in req.url else None)
    open_life(page)
    configure(page)

    # 快速记录只走本地草稿和正式保存，绝不触发 AI。
    page.locator('[data-life-capture]').click()
    page.locator('#lc-body').fill('虚构快速记录：阳台的一小块阳光。')
    page.locator('[data-lc-save]').click()
    page.locator('#sheet.open').wait_for(state='hidden')
    assert not requests
    assert '阳台的一小块阳光' in page.locator('#lf-feed').inner_text()

    turns = [
        {'reply': '那一刻还有什么声音吗？', 'readyToSummarize': False},
        {'reply': '热茶让这段时间慢了下来。', 'readyToSummarize': True},
        {'reply': '这句话也留在这里了。', 'readyToSummarize': False},
    ]
    summary = {'title': '阳台上的阳光', 'body': '阳台上的阳光落在杯边，我喝着热茶坐了一会儿。', 'mood': '平静', 'tags': ['阳台', '热茶'], 'sourceMessageCount': 4}
    failed = [False]

    def mock(route):
        payload = route.request.post_data_json
        payloads.append(payload)
        if failed[0]:
            failed[0] = False
            route.fulfill(status=500, body='provider private body')
            return
        system = payload['messages'][0]['content']
        if 'sourceMessageCount必须' in system:
            route.fulfill(json={'choices': [{'message': {'content': json.dumps(summary, ensure_ascii=False)}}]})
        else:
            route.fulfill(json={'choices': [{'message': {'content': json.dumps(turns.pop(0), ensure_ascii=False)}}]})

    page.route('https://life-ai.invalid/**', mock)
    page.locator('[data-life-chat]').click()
    page.locator('#sp-life-chat').wait_for()
    assert '今天有什么小事' in page.locator('#life-chat-messages').inner_text()
    page.locator('#life-chat-input').fill('阳台有一小块阳光。')
    page.locator('[data-life-chat-send]').click()
    page.locator('#dialog-scrim.show').wait_for()
    assert '阳台有一小块阳光' in page.locator('#dialog-scrim').inner_text()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.get_by_text('那一刻还有什么声音吗？').wait_for()
    assert len(payloads) == 1
    assert 'image_url' not in json.dumps(payloads[-1])

    # 同页同目标的连续纯文字不重复询问授权。
    page.locator('#life-chat-input').fill('还有一杯热茶。')
    page.locator('[data-life-chat-send]').click()
    page.get_by_text('热茶让这段时间慢了下来。').wait_for()
    assert page.locator('#dialog-scrim.show').count() == 0
    page.get_by_text('已经有一个值得留下的片段了').wait_for()
    screenshot(page, 'chat-ready', width, '#sp-life-chat')

    # 使用已形成的会话进入 A1；摘要可以编辑，保存会把完整对话留在本机。
    page.locator('[data-life-chat-summary]').click()
    page.locator('#sheet.open [data-life-summary-save]').wait_for()
    page.locator('#life-summary-title').fill('我改过的阳台片段')
    page.locator('#life-summary-body').fill('我改过的正文。')
    screenshot(page, 'summary-sheet', width, '#sheet')
    page.locator('[data-life-summary-return]').first.click()
    page.locator('#sheet.open').wait_for(state='hidden')
    page.locator('#sp-life-chat').wait_for()
    page.locator('[data-life-chat-summary]').click()
    page.locator('#sheet.open [data-life-summary-save]').wait_for()
    page.locator('[data-life-summary-save]').click()
    page.locator('#sp-life-chat').wait_for(state='detached')
    saved = next(note for note in read_rows(page, 'lifeNotes') if note.get('title') == '我改过的阳台片段')
    assert saved['body'] == '我改过的正文。'
    assert len(saved['conversation']) == 4

    # 正式记录可以找到原始对话并继续；失败不泄漏服务方正文，关闭后草稿会恢复。
    page.locator(f'[data-note="{saved["id"]}"]').click()
    page.locator('[data-lc-view-conversation]').click()
    page.locator('#sp-life-chat').wait_for()
    failed[0] = True
    page.locator('[data-life-chat-photo]').click()
    page.locator('#lchat-file').set_input_files(image(page, '虚构聊天照片.png', '#cfa66e'))
    page.locator('#life-chat-input').fill('失败也要留在草稿里。')
    page.locator('[data-life-chat-send]').click()
    page.locator('#dialog-scrim.show').wait_for()
    assert '照片：1 张' in page.locator('#dialog-scrim').inner_text()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('.life-chat-failed').wait_for()
    assert 'provider private body' not in page.locator('#sp-life-chat').inner_text()
    page.locator('[data-life-chat-retry]').click()
    page.get_by_text('这句话也留在这里了。').wait_for()
    page.locator('[data-act="back"]').click()
    page.locator('#sp-life-chat').wait_for(state='detached')
    page.locator(f'[data-note="{saved["id"]}"]').click()
    page.locator('[data-lc-view-conversation]').click()
    page.locator('#sp-life-chat').wait_for()
    assert '失败也要留在草稿里。' in page.locator('#life-chat-messages').inner_text()
    screenshot(page, 'chat-restored', width, '#sp-life-chat')
    page.locator('#life-chat-input').fill('很长的草稿内容' * 250)
    screenshot(page, 'chat-long-draft', width, '#sp-life-chat')
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            for width in (360, 390, 430, 1280):
                context = browser.new_context(viewport={'width': width, 'height': 900}, service_workers='block')
                try:
                    page = context.new_page(); page.set_default_timeout(7000)
                    run(page, width); print('PASS life AI', width, flush=True)
                finally:
                    context.close()
        finally:
            browser.close()
