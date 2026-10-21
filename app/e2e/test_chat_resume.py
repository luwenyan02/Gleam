"""退出/重进、流式检查点与重试；虚构数据和可控本地 SSE，不调用真实 AI。"""
from pathlib import Path
from time import monotonic
from playwright.sync_api import sync_playwright, expect
from test_life_ai import configure, open_life, read_rows, screenshot

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-resume'
MOCK = r'''(() => {
  const original = window.fetch.bind(window);
  window.__chatRequests = [];
  window.fetch = async (url, options) => {
    if (!String(url).startsWith('https://life-ai.invalid/')) return original(url, options);
    const request = { payload: JSON.parse(options.body), signal: options.signal };
    window.__chatRequests.push(request);
    const stream = new ReadableStream({
      start(controller) {
        request.delta = text => controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n'));
        request.finish = () => { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); };
        request.fail = () => controller.error(new TypeError('synthetic interrupted connection'));
        options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), {once:true});
      }
    });
    return new Response(stream, {headers:{'Content-Type':'text/event-stream'}});
  };
})();'''


def enter(page):
    page.locator('[data-life-chat]').click()
    page.locator('#life-chat-input').wait_for()


def leave(page):
    page.locator('#sp-life-chat .sub-head [data-act="back"]').click()
    page.locator('#sp-life-chat').wait_for(state='detached')


def send(page, text, count):
    page.locator('#life-chat-input').fill(text)
    page.locator('[data-life-chat-send]').click()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.wait_for_function('count => window.__chatRequests.length === count', arg=count)


def delta(page, text):
    page.evaluate('text => window.__chatRequests.at(-1).delta(text)', text)


def finish(page):
    page.evaluate('window.__chatRequests.at(-1).finish()')


def wait_for_draft(page, predicate, key=None):
    deadline = monotonic() + 5
    while monotonic() < deadline:
        draft = next((row for row in read_rows(page, 'lifeDrafts')
                      if key is None or row['key'] == key), None)
        if draft is not None and predicate(draft):
            return draft
        page.wait_for_timeout(40)
    raise AssertionError('聊天草稿未在5秒内保存到预期状态')


def appearance(page, theme, scale):
    page.evaluate('([theme, scale]) => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty("--seed-type", String(scale)); }', [theme, scale])
    assert page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--seed-type").trim()') == str(scale)


def run(page, width, theme, scale):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(MOCK)
    open_life(page)
    configure(page)
    appearance(page, theme, scale)
    enter(page)
    send(page, '虚构旅行：从北京出发去贵阳，一周怎么安排？', 1)
    # 尚无首字退出，重进仍等待同一个请求。
    leave(page)
    assert not page.evaluate('window.__chatRequests[0].signal.aborted')
    enter(page)
    expect(page.locator('#life-chat-status')).to_contain_text('正在想')
    expect(page.locator('#life-chat-input')).to_be_disabled()
    expect(page.locator('[data-life-chat-stop]')).to_be_visible()
    assert page.evaluate('window.__chatRequests.length') == 1
    delta(page, '## 虚构行程\n\n第一天，从北京出发。')
    expect(page.locator('.chat-streaming')).to_contain_text('第一天')
    leave(page)
    delta(page, '\n\n第二天，在贵阳慢慢逛。')
    stored = wait_for_draft(page, lambda draft: draft.get('chatReply', {}).get('content', '').endswith('贵阳慢慢逛。'))
    assert len(stored['messages']) == 1
    enter(page)
    expect(page.locator('.chat-streaming')).to_contain_text('第二天')
    screenshot(page, 'chat-resume-streaming-' + theme, width, '#sp-life-chat')
    page.screenshot(path=str(OUT / f'streaming-{width}-{theme}-{scale}.png'), animations='disabled')
    # 离页期间完整结束，再进入只有一条完整回答，无重复请求。
    leave(page)
    delta(page, '\n\n第七天，返回北京。')
    finish(page)
    wait_for_draft(page, lambda draft: len(draft['messages']) == 2 and not draft.get('chatReply'))
    enter(page)
    expect(page.locator('.assistant')).to_have_count(1)
    expect(page.locator('.assistant')).to_contain_text('第七天')
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    assert page.evaluate('window.__chatRequests.length') == 1
    page.reload()
    page.locator('#fab').wait_for()
    page.locator('[data-page="page-life"]').click()
    appearance(page, theme, scale)
    enter(page)
    expect(page.locator('.assistant')).to_contain_text('第七天')
    assert page.evaluate('window.__chatRequests.length') == 0
    # 模拟进程终止：重载后只恢复已保存的片段，需用户主动重试。
    send(page, '虚构追问：再推荐一个轻松的安排。', 1)
    delta(page, '可以留半天，去公园走走。')
    expect(page.locator('.chat-streaming')).to_contain_text('公园')
    leave(page)  # 立即落盘最新片段
    page.reload()
    page.locator('#fab').wait_for()
    page.locator('[data-page="page-life"]').click()
    appearance(page, theme, scale)
    enter(page)
    expect(page.locator('.chat-incomplete')).to_contain_text('公园')
    expect(page.locator('#life-chat-status')).to_contain_text('上次回复未完成')
    expect(page.locator('[data-life-chat-retry]')).to_be_visible()
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    assert page.evaluate('window.__chatRequests.length') == 0
    screenshot(page, 'chat-resume-interrupted-' + theme, width, '#sp-life-chat')
    page.screenshot(path=str(OUT / f'interrupted-{width}-{theme}-{scale}.png'), animations='disabled')
    # 重试不重复插入用户消息；重进后“停止”仍控制原请求。
    page.locator('[data-life-chat-retry]').click()
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.wait_for_function('window.__chatRequests.length === 1')
    delta(page, '重试时收到的片段。')
    leave(page)
    enter(page)
    expect(page.locator('.chat-streaming')).to_contain_text('重试时')
    page.locator('[data-life-chat-stop]').click()
    expect(page.locator('#life-chat-status')).to_contain_text('已停止')
    expect(page.locator('.chat-incomplete')).to_contain_text('重试时')
    assert page.evaluate('window.__chatRequests.at(-1).signal.aborted')
    page.locator('[data-life-chat-retry]').click()
    # 重进页面不会继承发送授权；重试仍须确认本轮素材和目的地。
    page.locator('#dialog-scrim [data-act="ok"]').click()
    page.wait_for_function('window.__chatRequests.length === 2')
    delta(page, '重试后的完整安排。')
    finish(page)
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    expect(page.locator('.user')).to_have_count(2)
    expect(page.locator('.assistant')).to_have_count(2)
    expect(page.locator('.chat-incomplete')).to_have_count(0)
    # 重新回答期间退出，原答案保留，成功后仅替换这一轮。
    page.locator('[data-chat-regenerate]').click()
    page.wait_for_function('window.__chatRequests.length === 3')
    delta(page, '重新回答的完整安排。')
    leave(page)
    enter(page)
    expect(page.locator('.chat-streaming')).to_contain_text('重新回答')
    expect(page.locator('.assistant:not(.chat-streaming)')).to_have_count(2)
    finish(page)
    expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
    expect(page.locator('.assistant')).to_have_count(2)
    expect(page.locator('.assistant').last).to_contain_text('重新回答')
    # 退出期间网络中断：片段和重试入口都保留。
    send(page, '虚构追问：最后一个问题。', 4)
    delta(page, '最后一轮的半段。')
    leave(page)
    page.evaluate('window.__chatRequests.at(-1).fail()')
    enter(page)
    expect(page.locator('[data-life-chat-retry]')).to_be_visible()
    expect(page.locator('.chat-incomplete')).to_contain_text('最后一轮')
    assert page.evaluate('window.__chatRequests.length') == 4
    # 新会话不会混入旧会话的回复；在同意发送前退出不应发出请求。
    page.locator('[data-chat-start]').click()
    expect(page.locator('.chat-welcome')).to_be_visible()
    page.locator('#life-chat-input').fill('另一段虚构会话')
    page.locator('[data-life-chat-send]').click()
    # 取消确认后退出，重开可找回未回复的消息并重试。
    page.locator('#dialog-scrim [data-act="cancel"]').click()
    leave(page)
    enter(page)
    expect(page.locator('.user')).to_have_count(1)
    expect(page.locator('[data-life-chat-retry]')).to_be_visible()
    assert page.evaluate('window.__chatRequests.length') == 4
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width, theme, scale in ((360, 'light', 1), (390, 'dark', 1), (400, 'light', 1.3), (430, 'light', 1), (1280, 'light', 1)):
            context = browser.new_context(viewport={'width': width, 'height': 890}, color_scheme=theme, reduced_motion='reduce',
                                          device_scale_factor=3 if width == 400 else 1, has_touch=width == 400)
            run(context.new_page(), width, theme, scale)
            context.close()
            print(f'PASS chat resume {width} {theme} {scale}', flush=True)
        browser.close()
