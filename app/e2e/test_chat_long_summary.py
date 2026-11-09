"""历史长会话完整整理、进度、取消与原文保留；全部为虚构数据和模拟接口。"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import open_life, configure, read_rows, URL
from chat_seed import index_chat_seed

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-long-summary'


def seed(page):
    page.evaluate('''async () => {
      const db = await new Promise(resolve => { const r = indexedDB.open('GleamDB'); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction('lifeNotes', 'readwrite');
      tx.objectStore('lifeNotes').put({id:93001,kind:'diary',title:'虚构长历史随记',body:'保存前不应改变的原正文',occurredAt:Date.now(),createdAt:1,updatedAt:1,deletedAt:0,
        conversation:Array.from({length:60},(_,i)=>({role:i%2?'assistant':'user',content:`虚构消息${i}：${'散步时看见树叶，保留原始细节。'.repeat(60)}`}))});
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
    }''')
    index_chat_seed(page)


def choose_history(page):
    page.locator('[data-chat-history]').click()
    page.locator('#chat-history-search').fill('虚构长历史随记')
    expect(page.locator('.chat-history-row')).to_have_count(1)
    page.locator('.chat-history-row').click()
    expect(page.locator('#life-chat-messages')).to_contain_text('虚构消息59')
    expect(page.locator('[data-chat-organize]')).to_be_enabled()


def run(browser, width, dark=False):
    context = browser.new_context(viewport={'width': width, 'height': 890}, device_scale_factor=3 if width == 400 else 1,
                                  has_touch=width < 1000, is_mobile=width < 1000, reduced_motion='reduce', service_workers='block')
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(URL)
                  or route.request.url.startswith(('data:', 'blob:')) else route.abort())
    page = context.new_page(); page.set_default_timeout(12000)
    errors, requests, held = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    open_life(page); configure(page); seed(page)
    original = next(note for note in read_rows(page, 'lifeNotes') if note['id'] == 93001)
    if dark:
        page.evaluate("document.documentElement.dataset.theme='dark';document.documentElement.style.setProperty('--seed-type','1.3')")
    page.locator('[data-life-chat]').click()
    choose_history(page)
    hold = [True]

    def mock(route):
        payload = route.request.post_data_json
        source = json.loads(payload['messages'][1]['content'])
        requests.append(source)
        assert len(payload['messages'][1]['content']) <= 24000
        if hold[0] and len(requests) == 2:
            held.append(route)
            return
        if '对话' in source:
            result = {'notes': '用户在公园散步，看见树叶。'}
        else:
            result = {'title': '虚构整理随记', 'body': '我在公园散步，看见了树叶。', 'tags': ['散步'], 'sourceMessageCount': 60}
        route.fulfill(json={'choices': [{'message': {'content': json.dumps(result, ensure_ascii=False)}}]})

    page.route('https://life-ai.invalid/**', mock)
    page.locator('[data-chat-organize]').click()
    expect(page.locator('#dialog-scrim.show')).to_contain_text('完整会话：60 条消息')
    expect(page.locator('#dialog-scrim.show')).to_contain_text('调用次数会增加')
    assert '虚构消息0' in page.locator('#dialog-scrim.show').inner_text()
    assert '虚构消息59' in page.locator('#dialog-scrim.show').inner_text()
    assert not requests
    page.screenshot(path=str(OUT / f'consent-{width}-{dark}.png'), animations='disabled')
    page.locator('#dialog-scrim [data-act="cancel"]').click()
    assert not requests
    page.locator('[data-chat-organize]').click()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('正在整理第 2/')
    expect(page.locator('[data-chat-organize]')).to_be_disabled()
    expect(page.locator('[data-life-chat-stop]')).to_be_visible()
    page.screenshot(path=str(OUT / f'progress-{width}-{dark}.png'), animations='disabled')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    assert page.locator('.sub-head').bounding_box()['y'] >= 0
    page.locator('[data-life-chat-stop]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('已停止')
    for route in held:
        try:
            route.abort()
        except Exception:
            pass
    held.clear(); hold[0] = False
    assert len(requests) == 2
    assert page.locator('[data-life-summary-save]').count() == 0
    assert next(note for note in read_rows(page, 'lifeNotes') if note['id'] == 93001) == original
    drafts = read_rows(page, 'lifeDrafts')
    if drafts:
        draft = next(draft for draft in drafts if draft['key'] == 'chat:note:93001')
        assert draft['messages'] == original['conversation'] and not draft.get('summaryProposal')

    # 重试完整整理：每条历史均参与请求，完成前不改正式记录，预览仍可返回聊天。
    requests.clear()
    page.locator('[data-chat-organize]').click()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.locator('[data-life-summary-save]').wait_for()
    pieces = [source for source in requests if '对话' in source]
    assert len(pieces) > 1
    assert [message for source in pieces for message in source['对话']] == original['conversation']
    assert requests[-1]['sourceMessageCount'] == 60
    assert next(note for note in read_rows(page, 'lifeNotes') if note['id'] == 93001) == original
    page.screenshot(path=str(OUT / f'summary-{width}-{dark}.png'), animations='disabled')
    page.locator('[data-life-summary-return]').first.click()
    page.locator('#sheet.open').wait_for(state='hidden')
    expect(page.locator('[data-chat-organize]')).to_contain_text('草稿')
    assert page.locator('#life-chat-messages .life-chat-bubble').count() == 60
    page.locator('[data-chat-organize]').click()
    page.locator('[data-life-summary-save]').click()
    page.locator('#sp-life-chat').wait_for(state='detached')
    saved = next(note for note in read_rows(page, 'lifeNotes') if note['id'] == 93001)
    assert saved['conversation'] == original['conversation']
    assert saved['title'] == '虚构整理随记' and saved['body'] == '我在公园散步，看见了树叶。'
    assert not errors, errors
    context.close()
    print('PASS long history summary', width, 'dark' if dark else 'light', flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 400, 430, 1280):
            run(browser, width)
        run(browser, 400, dark=True)
        browser.close()
