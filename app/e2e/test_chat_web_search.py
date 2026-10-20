"""搜索能力与数据继续工作，聊天不展示搜索状态和来源；使用合成 SSE。"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import URL, configure, read_rows
from test_browser_usability import assert_usable

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-web-search'
BRIDGE = r'''(() => {
  const original = window.fetch; window.__searchRequests = [];
  window.fetch = async (url, options) => {
    if (!String(url).includes('dashscope.aliyuncs.com/compatible-mode/v1/')) return original(url, options);
    window.__searchRequests.push({url: String(url), body: JSON.parse(options.body)});
    if (window.__searchFailure) return new Response('synthetic-private-error-marker', {status: 500});
    const stream = new ReadableStream({start(c) {
      window.__searchController = c;
      options.signal.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')), {once:true});
    }});
    return new Response(stream, {headers: {'Content-Type': 'text/event-stream'}});
  };
  window.__emitSearch = (events, close = false) => {
    const text = events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
    window.__searchController.enqueue(new TextEncoder().encode(text));
    if (close) window.__searchController.close();
  };
})();'''
SOURCES = [
    {'title': '虚构气象站：贵阳逐小时预报与降雨提示', 'url': 'https://weather.example.invalid/guiyang'},
    {'title': '用于窄屏检查的很长来源标题' * 5, 'url': 'https://forecast.example.invalid/daily?city=guiyang'},
    {'title': '<img src=x onerror=alert(1)>', 'url': 'javascript:alert(1)'},
]


def emit(page, events, close=False):
    page.evaluate('([events,close]) => window.__emitSearch(events,close)', [events, close])


def finish(page, text, searched=True):
    calls = [{'type': 'web_search_call', 'id': 'search-1', 'status': 'completed', 'action': {'type': 'search', 'sources': SOURCES}}] if searched else []
    emit(page, [{'type': 'response.output_text.delta', 'delta': text},
                {'type': 'response.completed', 'response': {'status': 'completed', 'output': calls + [
                    {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]}]}}], True)
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()


def assert_no_search_info(page):
    expect(page.locator('[data-chat-search],.chat-web-search,.chat-search-sources')).to_have_count(0)
    text = page.locator('#sp-life-chat').inner_text()
    for label in ['可联网搜索', '正在联网搜索', '已联网搜索', '本次未使用联网搜索', '本次搜索状态未返回', '来源（']:
        assert label not in text, label


def run(browser, width, height, theme, scale):
    context = browser.new_context(viewport={'width': width, 'height': height}, timezone_id='Asia/Shanghai', reduced_motion='reduce', service_workers='block')
    external = []; context.route('https://**/*', lambda r: (external.append(r.request.url), r.abort()))
    page = context.new_page(); page.add_init_script(BRIDGE); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(URL); page.locator('#fab').wait_for(); configure(page)
        page.evaluate('''async ([theme,scale]) => {
          const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
          const tx=db.transaction('settings','readwrite');
          for(const [key,value] of [['ai.baseUrl','https://dashscope.aliyuncs.com/compatible-mode/v1'],['ai.model','qwen3.8-max'],['theme.mode',theme]])tx.objectStore('settings').put({key,value});
          await new Promise(resolve=>tx.oncomplete=resolve); db.close();
        }''', [theme, scale])
        page.reload(); page.locator('#fab').wait_for()
        page.evaluate('scale=>document.documentElement.style.setProperty("--seed-type",scale)', str(scale))
        page.locator('[data-page="page-life"]').click(); page.locator('[data-life-chat]').click()
        page.locator('#life-chat-input').fill('今天贵阳天气怎么样？')
        page.locator('[data-life-chat-send]').click(); page.locator('#dialog-scrim [data-act="ok"]').click()
        page.wait_for_function('window.__searchRequests.length===1')
        payload = page.evaluate('window.__searchRequests[0]')
        assert payload['url'].endswith('/responses') and payload['body']['tools'] == [{'type': 'web_search'}]
        assert payload['body']['store'] is False and '没有联网工具' not in json.dumps(payload, ensure_ascii=False)
        emit(page, [{'type': 'response.web_search_call.searching'}])
        expect(page.locator('#life-chat-status')).to_have_text('拾光正在想…')
        assert_no_search_info(page)
        page.locator('#sp-life-chat .sub-head [data-act="back"]').click()
        page.locator('#sp-life-chat').wait_for(state='detached'); page.locator('[data-life-chat]').click()
        expect(page.locator('#life-chat-status')).to_have_text('拾光正在想…')
        assert_no_search_info(page)
        assert page.evaluate('window.__searchRequests.length') == 1
        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / f'searching-{width}-{theme}-{scale}.png'), animations='disabled')
        emit(page, [{'type': 'response.output_text.delta', 'delta': '正在整理虚构预报。'}])
        expect(page.locator('.chat-streaming .chat-message-text')).to_have_text('正在整理虚构预报。')
        expect(page.locator('#life-chat-status')).to_have_text('正在回复…')
        assert_no_search_info(page)
        finish(page, '本次检索到的虚构天气预报显示有雨，出门带伞。')
        card = page.locator('.life-chat-bubble.assistant').last
        expect(card.locator('.chat-message-text')).to_have_text('本次检索到的虚构天气预报显示有雨，出门带伞。')
        assert_no_search_info(page)
        assert 'weather.example.invalid' not in page.locator('#sp-life-chat').inner_text()
        assert not external, external
        stored = next(d for d in read_rows(page, 'lifeDrafts') if d['key'].startswith('chat:'))
        assert stored['messages'][-1]['search']['status'] == 'searched'
        assert [source['url'] for source in stored['messages'][-1]['search']['sources']] == [source['url'] for source in SOURCES[:2]]
        assert_usable(page, '#sp-life-chat'); page.screenshot(path=str(OUT / f'reply-{width}-{theme}-{scale}.png'), animations='disabled')
        # 离页、重进及重启后旧消息同样隐藏搜索信息，不重新搜索。
        page.locator('#sp-life-chat .sub-head [data-act="back"]').click()
        page.locator('#sp-life-chat').wait_for(state='detached')
        page.locator('[data-life-chat]').click()
        expect(page.locator('.assistant .chat-message-text')).to_have_count(1)
        assert_no_search_info(page)
        assert page.evaluate('window.__searchRequests.length') == 1
        page.reload(); page.locator('#fab').wait_for(); page.locator('[data-page="page-life"]').click(); page.locator('[data-life-chat]').click()
        expect(page.locator('.assistant .chat-message-text')).to_have_count(1)
        assert_no_search_info(page)
        assert page.evaluate('window.__searchRequests.length') == 0
        # 同一句重新回答未调用搜索，不能继承旧来源或声称已搜索。
        page.locator('[data-chat-regenerate]').click(); page.locator('#dialog-scrim [data-act="ok"]').click()
        page.wait_for_function('window.__searchRequests.length===1')
        finish(page, '本次没有执行搜索，实时天气尚未核实。', False)
        expect(page.locator('.assistant .chat-message-text')).to_have_text('本次没有执行搜索，实时天气尚未核实。')
        assert_no_search_info(page)
        saved = read_rows(page, 'lifeDrafts')
        reply = next(d for d in saved if d['key'].startswith('chat:'))['messages'][-1]
        assert reply['search'] == {'status': 'not-used', 'sources': []}
        # 失败不回显服务端正文、不静默回退重发，原问题可重试。
        page.evaluate('window.__searchFailure=true')
        page.locator('#life-chat-input').fill('再查一下明天天气。'); page.locator('[data-life-chat-send]').click()
        expect(page.locator('#life-chat-status')).to_contain_text('联网请求失败')
        assert page.evaluate('window.__searchRequests.length') == 2
        assert 'synthetic-private-error-marker' not in page.locator('#sp-life-chat').inner_text()
        page.evaluate('window.__searchFailure=false')
        page.locator('[data-life-chat-retry]').click(); page.wait_for_function('window.__searchRequests.length===3')
        emit(page, [{'type': 'response.web_search_call.searching'}])
        expect(page.locator('#life-chat-status')).to_have_text('拾光正在想…')
        assert_no_search_info(page)
        page.locator('[data-life-chat-stop]').click()
        expect(page.locator('#life-chat-status')).to_contain_text('已停止')
        assert page.evaluate('window.__searchRequests.length') == 3
        stored = next(d for d in read_rows(page, 'lifeDrafts') if d['key'].startswith('chat:'))
        assert stored['chatReply']['status'] == 'stopped' and stored['chatReply']['search'] == {'status': 'failed', 'sources': []}
        assert not errors, errors
        print('PASS search capability, persistence, regeneration and failure without search UI', width, height, theme, scale, flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for profile in [(360, 760, 'light', 1), (390, 844, 'light', 1), (430, 932, 'dark', 1),
                        (360, 560, 'light', 1.3), (400, 810, 'dark', 1.3), (1280, 900, 'light', 1)]:
            run(browser, *profile)
        browser.close()
