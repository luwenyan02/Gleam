"""取消发送的消息归属及清理：虚构素材、模拟模型响应和原生语音桥。"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import URL, configure, set_life_ai_enabled
from test_entry_receipts import image
from test_native_live_voice import MOCK
from test_browser_usability import assert_usable

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-send-status'


def cancel_send(page, text):
    set_life_ai_enabled(page, False)
    page.locator('#life-chat-input').fill(text)
    page.locator('[data-life-chat-send]').click()
    expect(page.locator('#dialog-scrim.show')).to_be_visible()
    expect(page.locator('#dialog-scrim.show')).to_contain_text('开启生活 AI')
    page.locator('#dialog-scrim [data-act="cancel"]').click()
    expect(page.locator('[data-life-chat-send]')).to_be_visible()


def run(browser, width, height, theme, scale):
    context = browser.new_context(viewport={'width': width, 'height': height}, service_workers='block', reduced_motion='reduce', timezone_id='Asia/Shanghai', color_scheme=theme)
    page = context.new_page(); page.add_init_script(MOCK)
    errors, external, payloads = [], [], []
    failure = [False]
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://**/*', lambda route: (external.append(route.request.url), route.abort()))

    def mock(route):
        payloads.append(route.request.post_data_json)
        if failure[0]:
            route.fulfill(status=500, body='private-provider-error-must-not-appear')
        else:
            route.fulfill(json={'choices': [{'message': {'content': '这是虚构的已完成回复。'}}]})

    page.route('https://life-ai.invalid/**', mock)
    try:
        page.goto(URL); page.locator('#fab').wait_for(); configure(page)
        page.locator('[data-page="page-life"]').click(); page.locator('[data-life-chat]').click()
        page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",scale)}', [theme, str(scale)])
        cancel_send(page, '虚构第一问：没有附照片。')
        first = page.locator('.life-chat-failed[data-chat-message-index="0"][data-chat-cancelled]')
        expect(first).to_contain_text('未发送')
        expect(first).not_to_contain_text('照片')
        expect(page.locator('.user button')).to_have_count(0)
        expect(page.locator('#life-chat-status')).to_be_empty()
        assert not payloads
        assert_usable(page, '#sp-life-chat')
        assert page.evaluate("document.documentElement.dataset.theme === 'dark'") == (theme == 'dark')
        OUT.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(OUT / f'text-cancel-{width}-{theme}-{scale}.png'), animations='disabled')
        # Each cancelled message retains its own retry target and attachment scope.
        page.locator('#lchat-file').set_input_files(image(page, '虚构照片.png', '#bada55'))
        expect(page.locator('#life-chat-photos img')).to_have_count(1)
        cancel_send(page, '虚构第二问：本条附了一张照片。')
        second = page.locator('.life-chat-failed[data-chat-message-index="1"][data-chat-cancelled]')
        expect(page.locator('[data-chat-cancelled]')).to_have_count(2)
        expect(second).to_contain_text('照片')
        first.locator('[data-life-chat-retry]').click()
        expect(page.locator('#dialog-scrim.show')).to_be_visible()
        assert not payloads, '取消首次启用确认不能发送无照片的旧问题'
        page.locator('#dialog-scrim [data-act="cancel"]').click()
        expect(first).to_be_visible()
        second.locator('[data-life-chat-retry]').click()
        expect(page.locator('#dialog-scrim.show')).to_be_visible()
        page.locator('#dialog-scrim [data-act="ok"]').click()
        expect(page.locator('.assistant .chat-message-text')).to_have_text('这是虚构的已完成回复。')
        expect(page.locator('[data-chat-cancelled]')).to_have_count(0)
        expect(page.locator('#life-chat-status')).to_be_empty()
        assert len(payloads) == 1 and 'image_url' in json.dumps(payloads[0])
        # A disabled AI setting still asks once; cancelling keeps the original answer.
        set_life_ai_enabled(page, False)
        page.locator('[data-chat-regenerate]').click()
        page.locator('#dialog-scrim [data-act="cancel"]').click()
        cancelled_answer = page.locator('.life-chat-failed[data-chat-message-index="2"][data-chat-cancelled]')
        expect(cancelled_answer).to_contain_text('已取消重新回答')
        expect(cancelled_answer).not_to_contain_text('未发送')
        expect(page.locator('.assistant .chat-message-text')).to_have_text('这是虚构的已完成回复。')
        expect(page.locator('.user [data-chat-cancelled]')).to_have_count(0)
        expect(page.locator('#life-chat-status')).to_be_empty()
        assert len(payloads) == 1
        assert_usable(page, '#sp-life-chat')
        assert page.evaluate("document.documentElement.dataset.theme === 'dark'") == (theme == 'dark')
        page.screenshot(path=str(OUT / f'regenerate-cancel-{width}-{theme}-{scale}.png'), animations='disabled')
        # Opening voice and receiving only user speech must not imply a reply has arrived.
        page.locator('[data-chat-voice]').click(); page.locator('[data-voice-start]').click()
        expect(page.locator('[data-voice-mute]')).to_be_visible()
        page.evaluate("window.__liveEvent({state:'listening',messages:[{id:'u1',role:'user',content:'虚构语音问题'}]})")
        expect(cancelled_answer).to_have_count(1)
        page.evaluate("window.__liveEvent({state:'speaking',messages:[{id:'u1',role:'user',content:'虚构语音问题'},{id:'a1',role:'assistant',content:'虚构语音已经回应。'}]})")
        expect(page.locator('.assistant .chat-message-text').last).to_have_text('虚构语音已经回应。')
        expect(page.locator('[data-chat-cancelled],.life-chat-failed')).to_have_count(0)
        expect(page.locator('#life-chat-status')).to_be_empty()
        page.locator('[data-voice-end]').click()
        expect(page.locator('[data-chat-cancelled]')).to_have_count(0)
        assert_usable(page, '#sp-life-chat')
        assert page.evaluate("document.documentElement.dataset.theme === 'dark'") == (theme == 'dark')
        page.screenshot(path=str(OUT / f'voice-cleared-{width}-{theme}-{scale}.png'), animations='disabled')
        # A new chat has no old notice; network errors keep the ordinary retry flow.
        page.locator('[data-chat-start]').click(); expect(page.locator('.chat-welcome')).to_be_visible()
        expect(page.locator('#life-chat-status')).to_be_empty()
        cancel_send(page, '虚构第三问：仅文字。')
        expect(page.locator('[data-chat-cancelled]')).not_to_contain_text('照片')
        failure[0] = True
        page.locator('[data-life-chat-retry]').click(); page.locator('#dialog-scrim [data-act="ok"]').click()
        expect(page.locator('#life-chat-status')).to_contain_text('暂时不可用')
        expect(page.locator('[data-chat-cancelled]')).to_have_count(0)
        expect(page.locator('.life-chat-failed [data-life-chat-retry]')).to_be_visible()
        failure[0] = False
        page.locator('[data-life-chat-retry]').click()
        expect(page.locator('.assistant .chat-message-text')).to_have_text('这是虚构的已完成回复。')
        expect(page.locator('#life-chat-status')).to_be_empty()
        assert not errors and not external, (errors, external)
        print('PASS message-scoped send cancellation, photos, regeneration, voice and retry', width, theme, scale, flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for profile in [(360, 760, 'light', 1), (390, 844, 'light', 1), (430, 932, 'dark', 1), (360, 560, 'light', 1.3), (400, 810, 'dark', 1.3), (1280, 900, 'light', 1)]:
            run(browser, *profile)
        browser.close()
