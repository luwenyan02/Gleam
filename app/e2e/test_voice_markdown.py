"""语音原文与 Markdown 展示：合成桥及本地模型响应，不调用真实音频或服务。"""
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import URL, configure, read_rows
from test_native_live_voice import MOCK, assert_inline
from test_browser_usability import assert_usable

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/voice-markdown'
RAW = ('周六上午可以去公园散步，中午在附近吃饭，下午沿河骑车。周日早上去博物馆，下午在家休息。'
       '请按自己的体力调整行程，遇到下雨时可以把户外活动换到室内。这只是行程建议，天气尚未核实，出发前需要查看最新预报。'
       '公园和博物馆的开放时间也需要提前核对，不能确定能否预约。如果觉得两天的安排比较满，可以只选择其中一天外出，另一天留给休息。')
DISPLAY = ('**周六**上午可以去公园散步，中午在附近吃饭，下午沿河骑车。\n\n'
           '**周日**早上去博物馆，下午在家休息。\n\n'
           '请按自己的体力调整行程，遇到下雨时可以把户外活动换到室内。如果觉得两天的安排比较满，可以只选择其中一天外出，另一天留给休息。\n\n'
           '> 这只是行程建议，天气尚未核实，出发前需要查看最新预报。公园和博物馆的开放时间也需要提前核对，不能确定能否预约。')
TABLE_RAW = '早餐可以选面包或鸡蛋，午餐可以吃米饭和蔬菜，晚餐可以选面条。这只是可选搭配，没有提供具体份量、热量或价格，也不能由此推断营养是否充足。' * 2
TABLE = '| 餐次 | 可选搭配 |\n| --- | --- |\n| 早餐 | 面包或鸡蛋 |\n| 午餐 | 米饭和蔬菜 |\n| 晚餐 | 面条 |\n\n没有提供具体份量、热量或价格，也不能由此推断营养是否充足。'


def emit(page, messages, state='listening'):
    page.evaluate('(value)=>window.__liveEvent(value)', {'state': state, 'messages': messages})


def start(page):
    page.locator('[data-chat-voice]').click()
    expect(page.locator('[data-voice-start]')).to_be_enabled()
    page.locator('[data-voice-start]').click()
    expect(page.locator('[data-voice-mute]')).to_be_visible()


def wait_saved(page, predicate):
    until = time.monotonic() + 6
    while time.monotonic() < until:
        rows = read_rows(page, 'lifeDrafts')
        if any(predicate(row) for row in rows):
            return
        page.wait_for_timeout(40)
    raise AssertionError('Voice source/display did not persist')


def run(browser, width, height, theme, scale):
    context = browser.new_context(viewport={'width': width, 'height': height}, service_workers='block', reduced_motion='reduce', timezone_id='Asia/Shanghai')
    page = context.new_page(); page.add_init_script(MOCK)
    page.add_init_script('Object.defineProperty(navigator,"clipboard",{value:{writeText:async text=>{window.__copied=text}}})')
    errors, external, payloads, held = [], [], [], []
    mode = ['hold']
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://**/*', lambda route: (external.append(route.request.url), route.abort()))

    def mock(route):
        payloads.append(route.request.post_data_json)
        if mode[0] == 'hold':
            held.append(route)
        elif mode[0] == 'error':
            route.fulfill(status=500, body='synthetic-private-provider-error')
        else:
            route.fulfill(json={'choices': [{'message': {'content': DISPLAY}}]})

    page.route('https://life-ai.invalid/**', mock)
    try:
        page.goto(URL); page.locator('#fab').wait_for(); configure(page)
        page.locator('[data-page="page-life"]').click(); page.locator('[data-life-chat]').click()
        page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",scale)}', [theme, str(scale)])
        page.locator('#life-chat-input').fill('尚未发送的虚构文字草稿')
        start(page)
        expect(page.locator('[data-voice-model],#voice-workspace')).to_have_count(0)
        if width == 390:
            # Older native bridges lack IDs: a late user transcript must retain its role.
            emit(page, [{'role': 'assistant', 'content': '旧桥助手先返回'}])
            emit(page, [{'role': 'user', 'content': '旧桥用户后返回'}, {'role': 'assistant', 'content': '旧桥助手先返回'}])
            expect(page.locator('.user .chat-message-text')).to_have_text('旧桥用户后返回')
            expect(page.locator('.assistant .chat-message-text')).to_have_text('旧桥助手先返回')
        user = {'id': 'u1', 'role': 'user', 'content': '请给我周末行程建议'}
        assistant = {'id': 'a1', 'role': 'assistant', 'content': RAW[:40], 'complete': False, 'search': {'status': 'searched', 'sources': [{'title': '虚构来源', 'url': 'https://source.invalid/voice'}]}}
        emit(page, [user, assistant], 'speaking')
        expect(page.locator('.assistant .chat-message-text')).to_contain_text(RAW[:40])
        assistant['content'] = RAW
        emit(page, [user, assistant], 'speaking')
        expect(page.locator('.assistant .chat-message-text')).to_have_text(RAW)
        assert not payloads, 'Do not layout partial or interrupted speech'
        assistant['complete'] = True
        emit(page, [user, assistant])
        expect(page.locator('.assistant .chat-message-text')).to_have_text(RAW)
        until = time.monotonic() + 5
        while not held and time.monotonic() < until:
            page.wait_for_timeout(30)
        assert len(held) == len(payloads) == 1
        emit(page, [user, assistant])
        assert len(payloads) == 1, 'Completion snapshots must not duplicate model calls'
        payload = payloads[0]
        assert payload['model'] == 'test-model' and len(payload['messages']) == 2
        assert json.loads(payload['messages'][1]['content']) == {'transcript': RAW}
        assert not any(key in payload for key in ['tools', 'enable_search', 'stream', 'audio'])
        assert '尚未发送' not in json.dumps(payload, ensure_ascii=False) and user['content'] not in json.dumps(payload, ensure_ascii=False)
        held.pop(0).fulfill(json={'choices': [{'message': {'content': DISPLAY}}]})
        expect(page.locator('.assistant strong').first).to_have_text('周六')
        expect(page.locator('.assistant blockquote')).to_contain_text('天气尚未核实')
        expect(page.locator('.assistant h2,.assistant h3,.assistant ul,.assistant table')).to_have_count(0)
        expect(page.locator('.assistant .chat-message-text')).to_have_count(1)
        expect(page.locator('.assistant [data-chat-search="searched"]')).to_have_count(1)
        expect(page.locator('.assistant .chat-search-sources a')).to_have_attribute('href', 'https://source.invalid/voice')
        emit(page, [user, assistant, {'id': 'u2', 'role': 'user', 'content': '我再想一想'}])
        expect(page.locator('.assistant strong').first).to_have_text('周六')
        page.locator('[data-chat-copy]').click()
        page.wait_for_function('text=>window.__copied===text', arg=DISPLAY)
        page.locator('#toast.show').wait_for(state='hidden')
        assert_inline(page); assert_usable(page, '#sp-life-chat')
        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / f'markdown-{width}-{theme}-{scale}.png'), animations='disabled')
        wait_saved(page, lambda row: any(m.get('content') == RAW and m.get('voiceDisplay') == DISPLAY for m in row.get('messages', [])))

        if width == 390:
            # A completed reply can finish layout after the microphone ends and a new voice call starts.
            table_reply = {'id': 'a2', 'role': 'assistant', 'content': TABLE_RAW, 'complete': True}
            emit(page, [user, assistant, {'id': 'u2', 'role': 'user', 'content': '再说说餐食搭配'}, table_reply])
            until = time.monotonic() + 5
            while not held and time.monotonic() < until:
                page.wait_for_timeout(30)
            assert len(held) == 1
            page.locator('[data-voice-end]').click(); expect(page.locator('.chat-voice-overlay')).to_have_count(0)
            assert any(call['method'] == 'end' for call in page.evaluate('window.__liveCalls'))
            start(page)
            latest = [{'id': 'u1', 'role': 'user', 'content': '你好'}, {'id': 'a1', 'role': 'assistant', 'content': '你好。', 'complete': True}]
            emit(page, latest)
            held.pop(0).fulfill(json={'choices': [{'message': {'content': TABLE}}]})
            expect(page.locator('.assistant table')).to_have_count(1)
            emit(page, latest)
            expect(page.locator('.assistant table')).to_have_count(1)
            expect(page.locator('.assistant strong').first).to_have_text('周六')
            assert len(payloads) == 2, 'Short voice replies need no layout request'
            assert_usable(page, '#sp-life-chat')
            page.screenshot(path=str(OUT / 'table-after-end.png'), animations='disabled')
            # A failed layout leaves the raw speech intact, and does not automatically retry.
            mode[0] = 'error'
            failure = {'id': 'a2', 'role': 'assistant', 'content': RAW + '失败验证', 'complete': True}
            emit(page, [*latest, failure])
            expect(page.locator('#toast')).to_contain_text('已保留原文')
            expect(page.locator('.assistant .chat-message-text').last).to_have_text(failure['content'])
            emit(page, [*latest, failure]); assert len(payloads) == 3
            # Backgrounding cancels outstanding formatting without clearing the raw transcript.
            mode[0] = 'hold'
            background = {'id': 'a3', 'role': 'assistant', 'content': RAW + '后台验证', 'complete': True}
            emit(page, [*latest, failure, background])
            until = time.monotonic() + 5
            while not held and time.monotonic() < until:
                page.wait_for_timeout(30)
            assert held
            page.evaluate('Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});document.dispatchEvent(new Event("visibilitychange"))')
            try:
                held.pop(0).fulfill(json={'choices': [{'message': {'content': '## 不应显示的后台结果'}}]})
            except Exception:
                pass  # The browser can already have cancelled the intercepted request.
            page.evaluate('delete document.hidden;document.dispatchEvent(new Event("visibilitychange"))')
            expect(page.locator('#life-chat-messages')).not_to_contain_text('不应显示的后台结果')
            page.locator('[data-voice-close]').click()
            # Switching to a new chat cancels layout even after voice itself has ended.
            start(page)
            emit(page, [{'id': 'u1', 'role': 'user', 'content': '会话切换验证'}, {'id': 'a1', 'role': 'assistant', 'content': RAW + '切换验证', 'complete': True}])
            until = time.monotonic() + 5
            while not held and time.monotonic() < until:
                page.wait_for_timeout(30)
            assert held
            page.locator('[data-voice-end]').click(); page.locator('[data-chat-start]').click()
            expect(page.locator('.chat-welcome')).to_be_visible()
            try:
                held.pop(0).fulfill(json={'choices': [{'message': {'content': '## 不应串入新聊天的结果'}}]})
            except Exception:
                pass
            expect(page.locator('#life-chat-messages')).not_to_contain_text('不应串入新聊天的结果')
            expect(page.locator('.life-chat-bubble')).to_have_count(0)
            page.locator('[data-chat-history]').click()
            page.locator('.chat-history-row').filter(has_text='请给我周末行程建议').click()
        else:
            page.locator('[data-voice-end]').click()
        expect(page.locator('#life-chat-input')).to_have_value('尚未发送的虚构文字草稿')
        page.reload(); page.locator('#fab').wait_for(); page.locator('[data-page="page-life"]').click(); page.locator('[data-life-chat]').click()
        expect(page.locator('.assistant strong').first).to_have_text('周六')
        expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        assert not errors and not external, (errors, external)
        print('PASS voice Markdown, original persistence, completion and stale isolation', width, theme, scale, flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for profile in [(360, 760, 'light', 1), (390, 844, 'light', 1), (430, 932, 'dark', 1), (360, 560, 'light', 1.3), (400, 810, 'dark', 1.3), (1280, 900, 'light', 1)]:
            run(browser, *profile)
        browser.close()
