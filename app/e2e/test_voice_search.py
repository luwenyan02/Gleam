"""实时语音保留搜索能力与数据，界面隐藏搜索信息；使用合成原生桥。"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import URL, configure
from test_native_live_voice import MOCK, assert_inline
from test_voice_markdown import emit, wait_saved
from test_browser_usability import assert_usable

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/live-voice-search'


def run(browser, width, height, theme, scale):
    context = browser.new_context(viewport={'width': width, 'height': height}, service_workers='block', reduced_motion='reduce', timezone_id='Asia/Shanghai')
    page = context.new_page(); page.add_init_script(MOCK)
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://**/*', lambda route: (external.append(route.request.url), route.abort()))
    try:
        page.goto(URL); page.locator('#fab').wait_for(); configure(page)
        page.locator('[data-page="page-life"]').click(); page.locator('[data-life-chat]').click()
        page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",scale)}', [theme, str(scale)])
        page.locator('[data-chat-voice]').click()
        expect(page.locator('[data-voice-start]')).to_be_enabled()
        expect(page.locator('.voice-consent')).to_have_count(0)
        assert 'dashscope.aliyuncs.com' not in page.locator('.chat-voice-overlay').inner_text()
        assert '可能产生费用' not in page.locator('.chat-voice-overlay').inner_text()
        OUT.mkdir(parents=True, exist_ok=True)
        assert_inline(page); assert_usable(page, '#sp-life-chat')
        page.screenshot(path=str(OUT / f'ready-{width}-{theme}-{scale}.png'), animations='disabled')
        page.locator('[data-voice-start]').click(); expect(page.locator('[data-voice-mute]')).to_be_visible()
        call = page.evaluate('window.__liveCalls.find(value=>value.method==="start").options')
        assert '已启用百炼内置联网搜索' in call['instructions']
        assert '当前语音未提供联网搜索工具' not in call['instructions']
        messages = [{'id': 'u1', 'role': 'user', 'content': '北京今天的天气怎么样？'}, {'id': 'a1', 'role': 'assistant', 'content': '正在回应天气问题。', 'search': {'status': 'enabled', 'sources': []}}]
        emit(page, messages, 'speaking')
        expect(page.locator('.assistant .chat-message-text')).to_have_text('正在回应天气问题。')
        expect(page.locator('[data-chat-search],.chat-web-search,.chat-search-sources')).to_have_count(0)
        messages[1].update(content='根据本轮查询到的虚构预报，北京今天有雨。', complete=True, search={'status': 'searched', 'sources': [
            {'title': '虚构天气预报与出行提醒' * 4, 'url': 'https://weather.invalid/beijing'},
            {'title': '虚构天气预报与出行提醒' * 4, 'url': 'https://weather.invalid/beijing'},
            {'url': 'javascript:alert(1)'}, {'url': 'https://user:secret@unsafe.invalid/'}]})
        emit(page, messages)
        expect(page.locator('.assistant .chat-message-text')).to_have_count(1)
        expect(page.locator('.assistant .chat-message-text')).to_have_text(messages[1]['content'])
        expect(page.locator('[data-chat-search],.chat-web-search,.chat-search-sources')).to_have_count(0)
        assert 'weather.invalid' not in page.locator('#sp-life-chat').inner_text()
        assert not external, 'Search source links must not be prefetched'
        assert_inline(page); assert_usable(page, '#sp-life-chat')
        page.screenshot(path=str(OUT / f'searched-{width}-{theme}-{scale}.png'), animations='disabled')
        for index, status in enumerate(['not-used', 'unknown', 'failed', 'searching', 'unsupported'], start=2):
            messages += [{'id': f'u{index}', 'role': 'user', 'content': f'虚构问题{index}'}, {'id': f'a{index}', 'role': 'assistant', 'content': f'第{index}轮虚构回答。', 'complete': True, 'search': {'status': status, 'sources': []}}]
            emit(page, messages)
            expect(page.locator('.assistant .chat-message-text')).to_have_count(index)
            expect(page.locator('[data-chat-search],.chat-web-search,.chat-search-sources')).to_have_count(0)
        assert '本次搜索状态未返回' not in page.locator('#sp-life-chat').inner_text()
        # Wait for the latest debounced snapshot, not an earlier searched-only save.
        wait_saved(page, lambda row: [message.get('search', {}).get('status') for message in row.get('messages', []) if message.get('role') == 'assistant'] == ['searched', 'not-used', 'unknown', 'failed', 'searching', 'unsupported'] and len(row['messages'][1]['search']['sources']) == 1)
        page.locator('[data-voice-end]').click()
        page.reload(); page.locator('#fab').wait_for(); page.locator('[data-page="page-life"]').click(); page.locator('[data-life-chat]').click()
        expect(page.locator('.assistant .chat-message-text')).to_have_count(6)
        expect(page.locator('[data-chat-search],.chat-web-search,.chat-search-sources')).to_have_count(0)
        expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        assert not errors and not external, (errors, external)
        print('PASS voice search capability and persistence with hidden search metadata', width, theme, scale, flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for profile in [(360, 760, 'light', 1), (390, 844, 'light', 1), (430, 932, 'dark', 1), (360, 560, 'light', 1.3), (400, 810, 'dark', 1.3), (1280, 900, 'light', 1)]:
            run(browser, *profile)
        browser.close()
