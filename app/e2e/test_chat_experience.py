"""聊天布局、会话隔离与语音权限验收；全部使用虚构数据和模拟接口。"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import URL, configure, open_life, read_rows, screenshot

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-experience'

def run(page, width):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    open_life(page)
    configure(page)
    assert page.locator('.lf-month-chevron').count() == 0
    page.locator('[data-life-chat]').click()
    page.locator('[data-chat-prompt]').first.wait_for()
    assert page.locator('[data-chat-prompt]').count() == 4
    assert page.locator('.sub-head [data-chat-history]').is_visible()
    assert page.locator('[data-life-chat-send]').is_disabled()
    assert page.locator('[data-chat-organize]').is_disabled()
    assert page.locator('[data-chat-start]').is_visible()
    assert page.locator('[data-chat-settings]').is_visible()
    assert page.locator('.chat-head-actions button').all_inner_texts() == ['新聊天', 'AI 设置', '会话']
    assert page.locator('.chat-compose-tools [data-chat-organize]').count() == 1
    assert page.locator('.chat-quick-actions,[data-chat-more]').count() == 0
    assert page.locator('#sp-life-chat h2').evaluate('''el => {
      const brand = el.querySelector('.chat-brand').getBoundingClientRect(), name = el.querySelector('.chat-brand-name').getBoundingClientRect();
      const ai = el.querySelector('em').getBoundingClientRect();
      return !el.querySelector('small') && Math.abs(ai.top-name.top) < 1;
    }''')
    for removed in ('聊聊想法与日常', '不必每天来，想说的时候我都在。', 'AI 也会出错，请核实重要信息'):
        assert removed not in page.locator('#sp-life-chat').inner_text()
    assert page.locator('.chat-compose-tools').evaluate('''el => {
      const buttons = [...el.querySelectorAll('button')].filter(b => !b.hidden).map(b => b.getBoundingClientRect());
      return buttons.every((b,i) => b.width >= 44 && b.height >= 44 && (!i || b.left >= buttons[i-1].right) && Math.abs(b.top-buttons[0].top) < 1);
    }''')
    for button in page.locator('[data-chat-prompt]').all():
        button.click()
        assert page.locator('#life-chat-input').input_value() == button.get_attribute('data-chat-prompt')
    assert page.locator('[data-chat-voice]').is_visible()
    page.locator('[data-chat-prompt]').first.click()
    assert '今天有件小事' in page.locator('#life-chat-input').input_value()
    # 中文输入法选字时 Enter 不提交。
    page.locator('#life-chat-input').evaluate("el => el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', isComposing:true, bubbles:true}))")
    assert page.locator('#dialog-scrim.show').count() == 0
    page.locator('#life-chat-input').fill('虚构会话一：帮我想三个散步的点子。')
    answer = '**试试看**\n\n先从一段不用赶时间的散步开始。\n\n## 三个点子\n\n1. 去公园，走一条没走过的小路。\n2. 逛旧街，看看街边的小店。\n3. 换一条回家的路。\n\n> 不用专门找故事，想走就走。\n\n## 如果想顺手留一点\n\n- 拍下一处让你停下来的地方。\n- 也可以什么都不记。\n\n' + '\n\n'.join(['这是用于检查长回答排版的虚构段落。内容需要保持易读，滚动时输入框仍然可用。'] * 5) + '\n\n```text\n' + 'long-code-' * 30 + '\n```'
    page.route('https://life-ai.invalid/**', lambda route: route.fulfill(status=200, content_type='text/event-stream', body='data: '+json.dumps({'choices':[{'delta':{'content':answer}}]}, ensure_ascii=False)+'\n\ndata: [DONE]\n\n'))
    page.locator('[data-life-chat-send]').click()
    page.locator('.chat-message-text strong').first.wait_for()
    page.locator('[data-life-chat-stop]').wait_for(state='hidden')
    assert page.locator('[data-chat-copy]').first.inner_text() == ''
    assert page.locator('[data-chat-regenerate] svg').count() == 1
    assert page.locator('.user [data-chat-copy]').count() == 0
    assert page.locator('.user .chat-message-actions').count() == 0
    reply_time = page.locator('.assistant .chat-reply-time').inner_text()
    assert page.locator('.assistant .chat-reply-time').evaluate('el => { const d = new Date(el.dateTime); return el.textContent === `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; }')
    for card in page.locator('.assistant .chat-message-content').all():
        assert card.locator('.chat-message-actions').count() == 1
        assert card.evaluate('''el => {
          const card = el.getBoundingClientRect(), actions = el.querySelector('.chat-message-actions').getBoundingClientRect();
          return actions.right <= card.right && actions.bottom <= card.bottom;
        }''')
    assert page.locator('.assistant .chat-message-text').first.evaluate('el => parseFloat(getComputedStyle(el).fontSize) === 15')
    assert page.locator('.assistant .chat-message-text').first.evaluate('el => parseFloat(getComputedStyle(el).lineHeight) < 25')
    page.evaluate("() => { navigator.clipboard.writeText = async text => { window.__copied = text; }; }")
    page.locator('[data-chat-copy]').first.click()
    assert page.locator('[data-chat-copy]').first.get_attribute('title') == '已复制'
    assert '试试看' in page.evaluate('window.__copied')
    assert page.locator('[data-chat-organize]').is_enabled()
    page.locator('[data-chat-start]').click()
    page.locator('.chat-welcome').wait_for()
    page.locator('#life-chat-input').fill('虚构会话二：尚未发送的草稿')
    page.wait_for_timeout(450)
    page.locator('[data-chat-history]').click()
    page.locator('#chat-history-search').fill('虚构会话一')
    expect(page.locator('.chat-history-row')).to_have_count(1)
    page.locator('.chat-history-row').click()
    page.locator('.chat-message-text strong').first.wait_for()
    assert page.locator('.assistant .chat-reply-time').inner_text() == reply_time
    assert page.locator('#life-chat-input').input_value() == ''
    page.wait_for_timeout(450)
    rows = read_rows(page, 'lifeDrafts')
    assert any(row.get('pendingReply') == '虚构会话二：尚未发送的草稿' for row in rows)
    assert len([row for row in rows if row['key'].startswith('chat:')]) == 2
    assert page.locator('#sp-life-chat .sub-head #chat-model').count() == 0
    assert page.locator('.assistant h3').count() == 2
    assert page.locator('.assistant blockquote').count() == 1
    assert page.locator('.assistant li').count() == 5
    page.locator('#life-chat-messages').evaluate('el => el.scrollTop = 0')
    page.locator('[data-chat-jump]').wait_for(state='visible')
    screenshot(page, 'chat-experience', width, '#sp-life-chat')
    page.screenshot(path=str(OUT / f'chat-{width}.png'), animations='disabled')
    # 跳到最新消息，长代码横向滚动不撑开页面；多行草稿不遮挡跳转按钮。
    page.locator('[data-chat-jump]').click()
    page.locator('[data-chat-jump]').wait_for(state='hidden')
    page.locator('#life-chat-input').fill('多行虚构草稿\n' * 10)
    page.locator('#life-chat-messages').evaluate('el => el.scrollTop = 0')
    page.locator('[data-chat-jump]').wait_for(state='visible')
    assert page.locator('[data-chat-jump]').bounding_box()['y'] + 44 <= page.locator('.life-chat-input-wrap').bounding_box()['y']
    page.locator('#life-chat-input').fill('')
    page.locator('[data-chat-history]').click()
    page.locator('[data-history-close]').click()
    page.wait_for_timeout(350)
    assert page.locator('[data-chat-history]').evaluate('el => el === document.activeElement')
    # 打开语音面板不申请麦克风、也不建立云端连接。
    page.add_init_script("navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }")
    page.evaluate("() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; }")
    page.route('**/__gleam/voice/config', lambda route: route.fulfill(json={'configured': True, 'workspace': 'synthetic-workspace'}))
    page.locator('#life-chat-input').fill('虚构草稿：打开语音时也不能丢。')
    page.locator('[data-chat-voice]').click()
    page.locator('[data-voice-start]:enabled').wait_for()
    assert page.locator('#voice-workspace,[data-voice-model],[data-voice-region]').count() == 0
    page.locator('[data-voice-start]').click()
    page.get_by_text('麦克风未获授权，可在浏览器设置中允许后重试').wait_for()
    screenshot(page, 'voice-permission', width, '.life-chat-input-wrap')
    page.screenshot(path=str(OUT / f'voice-{width}.png'), animations='disabled')
    page.locator('[data-voice-close]').click()
    page.locator('.chat-voice-overlay').wait_for(state='hidden')
    assert page.locator('#life-chat-input').input_value() == '虚构草稿：打开语音时也不能丢。'
    page.locator('[data-chat-start]').click()
    page.locator('.chat-welcome').wait_for()
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / f'empty-{width}.png'), animations='disabled')
    page.evaluate("document.documentElement.dataset.theme = 'dark'")
    page.screenshot(path=str(OUT / f'dark-empty-{width}.png'), animations='disabled')
    page.evaluate("delete document.documentElement.dataset.theme")
    # 真正的等待状态：服务尚未回复时允许停止，不显示假消息或时间。
    page.unroute('https://life-ai.invalid/**')
    held = []
    page.route('https://life-ai.invalid/**', lambda route: held.append(route))
    page.locator('#life-chat-input').fill('虚构问题：帮我安排一个轻松的周末。')
    page.locator('[data-life-chat-send]').click()
    page.wait_for_function("document.querySelector('#life-chat-status').textContent.includes('正在想')")
    assert page.locator('[data-chat-voice]').is_disabled()
    assert page.locator('[data-life-chat-photo]').is_disabled()
    screenshot(page, 'chat-waiting', width, '#sp-life-chat')
    page.screenshot(path=str(OUT / f'waiting-{width}.png'), animations='disabled')
    page.locator('[data-life-chat-stop]').click()
    page.wait_for_function("document.querySelector('#life-chat-status').textContent.includes('已停止')")
    for route in held:
        try:
            route.abort()
        except Exception:
            pass
    assert page.locator('[data-chat-voice]').is_enabled()
    assert not errors, errors

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1280):
            context = browser.new_context(viewport={'width':width, 'height':844}, reduced_motion='reduce')
            run(context.new_page(), width)
            context.close()
            print(f'PASS chat experience {width}', flush=True)
        browser.close()
