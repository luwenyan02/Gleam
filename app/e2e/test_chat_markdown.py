"""聊天表格与嵌套列表：只使用虚构内容和本地模拟响应。"""
from playwright.sync_api import sync_playwright, expect
from test_life_ai import configure, open_life, screenshot, OUT

ANSWER = '''## 核心功能模块

| 模块 | 说明 |
| --- | --- |
| **建模** | 多边形建模、雕刻、曲线与程序化节点 |
| 渲染 | 光线追踪、实时预览 |

4. **特定领域深度不足**：

   - 角色绑定和动画
   - 程序化特效
     - 复杂场景需要验证

5. **稳定性**：留意版本差异。
6. **技术支持**：查阅官方资料。

---

## 竞品对比（虚构示例）

| 维度 | 工具 A | 工具 B | 工具 C | 工具 D | 工具 E |
| :--- | :---: | :---: | :---: | :---: | ---: |
| 易用性 | 易上手 | 需要学习 | 易上手 | 需要学习 | 因人而异 |
| 扩展 | 插件 | 脚本 | 节点 | 插件 | API |
'''


def run(page, width):
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    open_life(page)
    configure(page)
    answer = [ANSWER]
    page.route('https://life-ai.invalid/**', lambda route: route.fulfill(json={
        'choices': [{'message': {'content': answer[0]}}]}))
    page.locator('[data-life-chat]').click()
    page.locator('#life-chat-input').fill('虚构测试：展示一份表格和嵌套列表。')
    page.locator('[data-life-chat-send]').click()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    expect(page.locator('.assistant table')).to_have_count(2)
    expect(page.locator('.assistant hr')).to_have_count(1)
    expect(page.locator('.assistant ol > li')).to_have_count(3)
    expect(page.locator('.assistant ol > li > ul > li > ul')).to_have_count(1)
    page.locator('#life-chat-messages').evaluate('el => el.scrollTop = 0')
    screenshot(page, 'markdown-list-table', width, '#sp-life-chat')
    # 精简底部文案后，较宽屏幕可在当前可视区容纳更多内容。
    # 距底部不足 100px 时回到底部按钮本就隐藏，不能无条件点击。
    remaining = page.locator('#life-chat-messages').evaluate('el => el.scrollHeight - el.scrollTop - el.clientHeight')
    jump = page.locator('[data-chat-jump]')
    if remaining >= 100:
        expect(jump).to_be_visible()
        jump.click()
    else:
        expect(jump).to_be_hidden()
    wide = page.locator('.chat-table-scroll').last
    wide.scroll_into_view_if_needed()
    if width < 768:
        assert wide.evaluate('el => el.scrollWidth > el.clientWidth')
        wide.evaluate('el => el.scrollLeft = el.scrollWidth')
        assert wide.evaluate('el => el.scrollLeft > 0')
    wide.focus()
    screenshot(page, 'markdown-wide-table', width, '#sp-life-chat')
    assert page.locator('.life-chat-input-wrap').bounding_box()['y'] > wide.bounding_box()['y']
    page.evaluate("document.documentElement.dataset.theme = 'dark'")
    screenshot(page, 'markdown-wide-table-dark', width, '#sp-life-chat')
    page.evaluate("document.documentElement.dataset.theme = 'light'")
    answer[0] = '好呀，我在听。\n\n是什么样的小事？慢慢说就好。'
    page.locator('#life-chat-input').fill('虚构测试：简短回复。')
    page.locator('[data-life-chat-send]').click()
    expect(page.locator('.assistant')).to_have_count(2)
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    short = page.locator('.assistant .chat-message-text').last
    expect(short.locator('p')).to_have_count(2)
    assert short.locator('p').first.evaluate('el => parseFloat(getComputedStyle(el).marginBottom) < 12')
    for text in page.locator('.chat-message-text').all():
        overlap = text.evaluate('''el => {
      const buttons = [...el.parentElement.querySelectorAll('.chat-message-actions button')].map(b => b.getBoundingClientRect());
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        for (const r of range.getClientRects()) for (const b of buttons) {
          if (r.width && r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) return {text:walker.currentNode.textContent, textRect:r.toJSON(), buttonRect:b.toJSON(), padding:getComputedStyle(el.parentElement).padding, slot:el.querySelector('.chat-action-slot')?.getBoundingClientRect().toJSON(),card:el.parentElement.getBoundingClientRect().toJSON()};
        }
      }
      return null;
        }''')
        assert not overlap, overlap
    screenshot(page, 'markdown-short-reply', width, '#sp-life-chat')
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1280):
            context = browser.new_context(viewport={'width': width, 'height': 844}, reduced_motion='reduce')
            run(context.new_page(), width)
            context.close()
            print(f'PASS chat Markdown {width}', flush=True)
        browser.close()
