"""生活 AI 对话验收：所有数据均为虚构，外部请求由本地 mock 拦截。"""
import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from test_entry_receipts import image

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/life-ai'


def read_rows(page, table):
    return page.evaluate('''table => new Promise((resolve, reject) => {
      const request = indexedDB.open('GleamDB');
      request.onsuccess = () => { const db = request.result; const r = db.transaction(table).objectStore(table).getAll();
        r.onsuccess = () => { resolve(JSON.parse(JSON.stringify(r.result))); db.close(); }; r.onerror = () => reject(r.error); };
    })''', table)


def set_life_ai_enabled(page, enabled):
    page.evaluate('''enabled => new Promise(resolve => {
      const request = indexedDB.open('GleamDB'); request.onsuccess = () => {
        const db = request.result, tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put({key:'life.aiEnabled',value:enabled});
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    })''', enabled)


def configure(page):
    page.evaluate('''async () => {
      sessionStorage.setItem('gleam-secret:ai.apiKey', 'synthetic-test-key');
      const db = await new Promise(resolve => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction(['settings','lifeNotes'], 'readwrite');
      for (const [key,value] of [['ai.baseUrl','https://life-ai.invalid/v1'], ['ai.model','test-model'], ['life.aiEnabled',true]]) tx.objectStore('settings').put({key,value});
      const d = new Date(); d.setHours(12,0,0,0); d.setDate(d.getDate() - (d.getDay()+6)%7 - 7);
      tx.objectStore('lifeNotes').put({id:900001,kind:'diary',title:'虚构周末散步',body:'散步时看见一只橘猫。',occurredAt:d.getTime(),createdAt:1,updatedAt:1,deletedAt:0});
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
    saved_quick_notes = [note for note in read_rows(page, 'lifeNotes')
                         if note.get('body') == '虚构快速记录：阳台的一小块阳光。' and not note.get('deletedAt')]
    assert len(saved_quick_notes) == 1, '快速记录必须已提交且只保存一次'
    # Closing follows the committed save; the life-changed feed refresh is still asynchronous.
    expect(page.locator('#lf-feed')).to_contain_text('阳台的一小块阳光')
    assert '阳台的一小块阳光' in page.locator('#lf-feed').inner_text()

    turns = [
        {'reply': '那一刻还有什么声音吗？', 'readyToSummarize': False},
        {'reply': '热茶让这段时间慢了下来。', 'readyToSummarize': True},
        {'reply': '同一张照片再次选择，也留在这一轮。', 'readyToSummarize': True},
        {'reply': '这句话也留在这里了。', 'readyToSummarize': False},
    ]
    summary = {'title': '阳台上的阳光', 'body': '阳台上的阳光落在杯边，我喝着热茶坐了一会儿。', 'mood': '平静', 'tags': ['阳台', '热茶'], 'sourceMessageCount': 6}
    failed, hold, held = [False], [False], []

    def mock(route):
        payload = route.request.post_data_json
        payloads.append(payload)
        if hold[0]:
            held.append(route)
            return
        if failed[0]:
            failed[0] = False
            route.fulfill(status=500, body='provider private body')
            return
        system = payload['messages'][0]['content']
        if '拾光周刊' in system:
            route.fulfill(json={'choices': [{'message': {'content': json.dumps({'title':'橘猫经过的一周','blocks':[{'noteId':900001,'text':'散步时，看见了一只橘猫。'}]}, ensure_ascii=False)}}]})
        elif 'sourceMessageCount必须' in system:
            route.fulfill(json={'choices': [{'message': {'content': json.dumps(summary, ensure_ascii=False)}}]})
        else:
            route.fulfill(json={'choices': [{'message': {'content': json.dumps(turns.pop(0), ensure_ascii=False)}}]})

    page.route('https://life-ai.invalid/**', mock)
    set_life_ai_enabled(page, False)
    page.locator('[data-life-chat]').click()
    page.locator('#sp-life-chat').wait_for()
    assert '今天有什么小事' in page.locator('#life-chat-messages').inner_text()
    page.locator('#life-chat-input').fill('阳台有一小块阳光。')
    page.locator('[data-life-chat-send]').click()
    page.locator('#dialog-scrim.show').wait_for()
    expect(page.locator('#dialog-scrim.show')).to_contain_text('开启生活 AI')
    assert not payloads, '首次启用确认前不能发送聊天'
    page.locator('#dialog-scrim [data-act="cancel"]').click()
    page.locator('.life-chat-failed').wait_for()
    assert not payloads
    page.locator('[data-life-chat-retry]').click()
    page.locator('#dialog-scrim.show').wait_for()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.get_by_text('那一刻还有什么声音吗？').wait_for()
    assert len(payloads) == 1
    assert 'image_url' not in json.dumps(payloads[-1])

    # 已启用聊天直接发送当前设置与本轮照片，不重复弹出内容确认。
    same_photo = image(page, '虚构聊天首图.png', '#cfa66e')
    page.locator('[data-life-chat-photo]').click()
    page.locator('#lchat-file').set_input_files(same_photo)
    page.evaluate('''async () => { const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)}); const tx=db.transaction('settings','readwrite');tx.objectStore('settings').put({key:'ai.model',value:'test-model-2'});await new Promise(r=>tx.oncomplete=r);db.close(); }''')
    page.locator('#life-chat-input').fill('还有一杯热茶。')
    page.locator('[data-life-chat-send]').click()
    page.get_by_text('热茶让这段时间慢了下来。').wait_for()
    expect(page.locator('#dialog-scrim.show')).to_have_count(0)
    assert payloads[-1]['model'] == 'test-model-2'
    assert 'image_url' in json.dumps(payloads[-1])
    page.locator('[data-life-chat-photo]').click()
    page.locator('#lchat-file').set_input_files(same_photo)
    page.locator('#life-chat-input').fill('我又选了同一张照片。')
    page.locator('[data-life-chat-send]').click()
    page.get_by_text('同一张照片再次选择，也留在这一轮。').wait_for()
    expect(page.locator('#dialog-scrim.show')).to_have_count(0)
    assert 'image_url' in json.dumps(payloads[-1])
    assert page.get_by_text('已经有一个值得留下的片段了').count() == 0
    screenshot(page, 'chat-ready', width, '#sp-life-chat')

    # 使用已形成的会话进入 A1；摘要可以编辑，保存会把完整对话留在本机。
    page.locator('[data-chat-organize]').click()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('#sheet.open [data-life-summary-save]').wait_for()
    page.locator('#life-summary-title').fill('我改过的阳台片段')
    page.locator('#life-summary-body').fill('我改过的正文。')
    page.locator('summary').filter(has_text='照片、日期与回访').click()
    assert page.locator('#life-summary-photos img').count() == 2
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
    assert len(saved['conversation']) == 6
    assert len(saved.get('photoRefs', [])) == 2
    assert 'photos' not in saved['conversation'][2]
    assert saved['conversation'][2]['photoRefs'] == [saved['photoRefs'][0]]
    assert saved['conversation'][4]['photoRefs'] == [saved['photoRefs'][1]]
    assert not any(row['key'] == 'chat:new' for row in read_rows(page, 'lifeDrafts'))

    # 关闭动画尚未结束就重开时，旧页面的延迟写入不得覆盖新会话。
    page.locator('[data-life-chat]').click()
    page.locator('#life-chat-input').fill('立即重开也不能丢的草稿。')
    page.locator('#sp-life-chat [data-act="back"]').click()
    page.wait_for_timeout(50)
    page.evaluate("document.querySelector('[data-life-chat]').click()")
    page.locator('#sp-life-chat').last.wait_for()
    page.wait_for_timeout(500)
    assert page.locator('#sp-life-chat').count() == 1
    assert page.locator('#sp-life-chat #life-chat-input').input_value() == '立即重开也不能丢的草稿。'
    page.locator('#sp-life-chat [data-act="back"]').click()
    page.locator('#sp-life-chat').wait_for(state='detached')

    # 正式记录可以找到原始对话并继续；失败不泄漏服务方正文，关闭后草稿会恢复。
    page.locator(f'[data-note="{saved["id"]}"]').click()
    page.locator('[data-lc-view-conversation]').click()
    page.locator('#sp-life-chat').wait_for()
    failed[0] = True
    page.locator('[data-life-chat-photo]').click()
    page.locator('#lchat-file').set_input_files(image(page, '虚构聊天照片.png', '#cfa66e'))
    page.locator('#life-chat-input').fill('失败也要留在草稿里。')
    page.locator('[data-life-chat-send]').click()
    page.locator('.life-chat-failed').wait_for()
    expect(page.locator('#dialog-scrim.show')).to_have_count(0)
    assert 'provider private body' not in page.locator('#sp-life-chat').inner_text()
    screenshot(page, 'chat-failed', width, '#sp-life-chat')
    page.locator('[data-life-chat-retry]').click()
    page.get_by_text('这句话也留在这里了。').wait_for()
    expect(page.locator('#dialog-scrim.show')).to_have_count(0)
    page.locator('[data-act="back"]').click()
    page.locator('#sp-life-chat').wait_for(state='detached')
    page.locator(f'[data-note="{saved["id"]}"]').click()
    page.locator('[data-lc-view-conversation]').click()
    page.locator('#sp-life-chat').wait_for()
    assert '失败也要留在草稿里。' in page.locator('#life-chat-messages').inner_text()
    screenshot(page, 'chat-restored', width, '#sp-life-chat')
    page.locator('#life-chat-input').fill('很长的草稿内容' * 250)
    screenshot(page, 'chat-long-draft', width, '#sp-life-chat')
    pending = page.locator('#life-chat-input').input_value()
    page.locator('[data-act="back"]').click()
    page.locator('#sp-life-chat').wait_for(state='detached')
    page.locator(f'[data-note="{saved["id"]}"]').click()
    page.locator('[data-lc-view-conversation]').click()
    page.locator('#sp-life-chat').wait_for()
    assert page.locator('#life-chat-input').input_value() == pending

    # 在途请求可以停止，用户消息与本地草稿仍保留。
    page.locator('#life-chat-input').fill('这条请求先停一下。')
    hold[0] = True
    page.locator('[data-life-chat-send]').click()
    page.locator('[data-life-chat-stop]').wait_for(state='visible')
    expect(page.locator('#dialog-scrim.show')).to_have_count(0)
    page.locator('[data-life-chat-stop]').click()
    page.wait_for_function("document.querySelector('#life-chat-status').textContent.includes('已停止')")
    for pending_route in held:
        try:
            pending_route.abort()
        except Exception:
            pass
    held.clear()
    hold[0] = False
    page.locator('[data-act="back"]').click()
    page.locator('#sp-life-chat').wait_for(state='detached')

    # 周刊仍只使用用户选择的正式记录；预览不会自动收藏。
    page.locator('[data-life-edition]').click()
    page.locator('[data-le-source="900001"]').wait_for()
    page.locator('[data-le-generate]').click()
    page.locator('#dialog-scrim.show').wait_for()
    assert '照片不发送，账单不发送' in page.locator('#dialog-scrim').inner_text()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('#le-title').wait_for()
    assert read_rows(page, 'lifeEditions') == []
    page.locator('#le-title').fill('我的橘猫小报')
    page.locator('[data-le-save]').click()
    page.locator('[data-le-edit]').wait_for()
    assert len(read_rows(page, 'lifeEditions')) == 1
    screenshot(page, 'weekly-paper', width, '#sp-life-edition')
    page.locator('[data-act="back"]').click()
    page.locator('#sp-life-edition').wait_for(state='detached')

    # 历史回访保留并可明确忽略。
    page.evaluate('''async id => { const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const tx=db.transaction('lifeNotes','readwrite'),s=tx.objectStore('lifeNotes'),q=s.get(id);q.onsuccess=()=>s.put({...q.result,review:{...(q.result.review||{}),revisitAt:Date.now()-86400000}});await new Promise(r=>tx.oncomplete=r);db.close(); }''', saved['id'])
    page.reload(); page.locator('#fab').wait_for(); page.locator('[data-page="page-life"]').click()
    page.locator(f'[data-revisit-dismiss="{saved["id"]}"]').wait_for()
    page.locator(f'[data-revisit-dismiss="{saved["id"]}"]').click()
    page.locator(f'[data-revisit-dismiss="{saved["id"]}"]').wait_for(state='detached')
    assert next(note for note in read_rows(page, 'lifeNotes') if note['id'] == saved['id'])['review']['dismissedAt'] > 0
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            for width in (360, 390, 430, 1280):
                context = browser.new_context(viewport={'width': width, 'height': 900}, service_workers='block')
                try:
                    page = context.new_page(); page.set_default_timeout(12000)
                    run(page, width); print('PASS life AI', width, flush=True)
                except Exception:
                    page.screenshot(path=str(OUT / f'failure-{width}.png'), animations='disabled')
                    print('LIFE_AI_FAILURE_STATE', {
                        'width': width,
                        'feed': page.locator('#lf-feed').inner_text(),
                        'saved_quick_count': sum(note.get('body') == '虚构快速记录：阳台的一小块阳光。'
                                                 and not note.get('deletedAt') for note in read_rows(page, 'lifeNotes')),
                    }, flush=True)
                    raise
                finally:
                    context.close()
        finally:
            browser.close()
