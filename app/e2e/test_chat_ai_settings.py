"""聊天配置入口回归：独立浏览器、虚构数据，不调用云端模型。"""
from playwright.sync_api import sync_playwright, expect
from test_life_ai import open_life, screenshot, OUT


def run(page, width):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    open_life(page)
    page.locator('[data-life-chat]').click()
    page.locator('#life-chat-input').fill('虚构测试：想聊聊今天的散步。')
    page.locator('[data-life-chat-send]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('配置 AI')
    page.locator('#life-chat-input').fill('尚未发送的虚构草稿')
    screenshot(page, 'chat-ai-config-error', width, '#sp-life-chat')
    page.locator('[data-chat-config-error]').click()
    expect(page.locator('#sp-settings')).to_have_attribute('aria-hidden', 'false')
    expect(page.locator('#ai-provider')).to_be_in_viewport()
    expect(page.locator('#sp-settings [data-act="back"]')).to_be_in_viewport()
    screenshot(page, 'chat-ai-config-target', width, '#sp-settings')
    page.locator('#sp-settings [data-act="back"]').click()
    expect(page.locator('#sp-settings')).to_have_count(0)
    expect(page.locator('#life-chat-input')).to_have_value('尚未发送的虚构草稿')
    page.locator('[data-chat-settings]').click()
    expect(page.locator('#ai-provider')).to_be_in_viewport()
    page.locator('#sp-settings [data-act="back"]').click()
    expect(page.locator('#sp-settings')).to_have_count(0)
    expect(page.locator('[data-chat-settings]')).to_be_focused()
    expect(page.locator('#life-chat-input')).to_have_value('尚未发送的虚构草稿')
    expect(page.locator('.chat-message-text')).to_contain_text('今天的散步')
    expect(page.locator('[data-chat-settings]')).to_be_focused()
    page.locator('[data-chat-settings]').click()
    expect(page.locator('#ai-provider')).to_be_in_viewport()
    page.locator('#ai-base').fill('https://life-ai.invalid/v1')
    page.locator('#ai-base').press('Tab')
    page.wait_for_timeout(200)
    page.locator('#ai-model').fill('synthetic-model')
    page.locator('#ai-model').press('Tab')
    page.wait_for_timeout(200)
    page.locator('#sp-settings [data-act="back"]').click()
    expect(page.locator('#sp-settings')).to_have_count(0)
    expect(page.locator('#life-chat-input')).to_have_value('尚未发送的虚构草稿')
    page.locator('[data-chat-settings]').click()
    expect(page.locator('#ai-model')).to_have_value('synthetic-model')
    page.locator('#sp-settings [data-act="back"]').click()
    expect(page.locator('#sp-settings')).to_have_count(0)
    # 仅填地址和模型、缺少 Key 时也提供入口；补齐后可重试原消息。
    page.locator('[data-life-chat-retry]').click()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('尚未配置 AI 接口')
    expect(page.locator('[data-chat-config-error]')).to_be_enabled()
    page.locator('[data-chat-config-error]').click()
    page.locator('#ai-key').fill('synthetic-test-key')
    page.locator('#ai-key').press('Tab')
    page.wait_for_timeout(200)
    page.locator('#sp-settings [data-act="back"]').click()
    expect(page.locator('#sp-settings')).to_have_count(0)
    page.route('https://life-ai.invalid/**', lambda route: route.fulfill(json={
        'choices': [{'message': {'content': '虚构回复：设置完成，可以继续了。'}}]}))
    page.locator('[data-life-chat-retry]').click()
    expect(page.locator('.assistant .chat-message-text')).to_contain_text('设置完成')
    expect(page.locator('[data-chat-config-error]')).to_be_hidden()
    expect(page.locator('#life-chat-input')).to_have_value('尚未发送的虚构草稿')
    expect(page.locator('.user')).to_have_count(1)
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1280):
            context = browser.new_context(viewport={'width': width, 'height': 844}, reduced_motion='reduce')
            run(context.new_page(), width)
            context.close()
            print(f'PASS chat AI settings {width}', flush=True)
        browser.close()
