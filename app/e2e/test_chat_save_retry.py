"""临时存储失败后重开会话，无需重新输入即可保存；全部使用虚构草稿。"""
from playwright.sync_api import sync_playwright, expect
from test_life_ai import open_life, configure, read_rows, URL
from test_chat_resume import MOCK, enter, leave, send, delta, finish, wait_for_draft

FAULT = '''(() => {
  window.__draftWrites = { fail: false, failed: 0, writes: 0 };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(...args) {
    if (this.name === 'lifeDrafts') {
      window.__draftWrites.writes++;
      if (window.__draftWrites.fail) {
        window.__draftWrites.failed++;
        throw new DOMException('虚构临时存储故障', 'QuotaExceededError');
      }
    }
    return put.apply(this, args);
  };
})();'''


def run(browser, action, reply=False, dark=False):
    context = browser.new_context(viewport={'width': 400, 'height': 890}, device_scale_factor=3)
    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(URL)
                  or route.request.url.startswith(('data:', 'blob:')) else route.abort())
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(MOCK)
    page.add_init_script(FAULT)
    open_life(page)
    configure(page)
    if dark:
        page.evaluate("document.documentElement.dataset.theme='dark';document.documentElement.style.setProperty('--seed-type','1.3')")
    enter(page)
    page.locator('#life-chat-input').fill('虚构已保存草稿')
    wait_for_draft(page, lambda draft: draft.get('pendingReply') == '虚构已保存草稿')
    if reply:
        send(page, '虚构提问', 1)
        wait_for_draft(page, lambda draft: bool(draft.get('chatReply')))
    page.evaluate('window.__draftWrites.fail=true')
    if reply:
        delta(page, '虚构未落盘的完整回复')
        finish(page)
        expect(page.locator('.assistant')).to_contain_text('虚构未落盘的完整回复')
    else:
        page.locator('#life-chat-input').fill('虚构未落盘的新输入')
    page.wait_for_function('window.__draftWrites.failed>0')
    failures = page.evaluate('window.__draftWrites.failed')
    leave(page)
    # 输入有离页重试；回复任务自己已经失败且未落盘，均须保留内存快照。
    if not reply:
        page.wait_for_function('n => window.__draftWrites.failed>n', arg=failures)
    stored = read_rows(page, 'lifeDrafts')[0]
    if reply:
        assert not any(m['content'] == '虚构未落盘的完整回复' for m in stored['messages'])
    else:
        assert stored['pendingReply'] == '虚构已保存草稿'
    page.evaluate('window.__draftWrites.fail=false')
    enter(page)
    if reply:
        expect(page.locator('.assistant')).to_contain_text('虚构未落盘的完整回复')
    else:
        expect(page.locator('#life-chat-input')).to_have_value('虚构未落盘的新输入')
    if action == 'leave':
        leave(page)
    elif action == 'history':
        page.locator('[data-chat-history]').click()
        page.locator('#chat-history-search').wait_for()
    else:
        page.locator('[data-chat-start]').click()
        expect(page.locator('#life-chat-input')).to_have_value('')
    wait_for_draft(page, lambda draft: any(m['content'] == '虚构未落盘的完整回复' for m in draft['messages'])
                   if reply else draft.get('pendingReply') == '虚构未落盘的新输入', key=stored['key'])
    page.reload()
    page.locator('#fab').wait_for()
    page.locator('[data-page="page-life"]').click()
    enter(page)
    if reply:
        expect(page.locator('.assistant')).to_contain_text('虚构未落盘的完整回复')
    else:
        expect(page.locator('#life-chat-input')).to_have_value('虚构未落盘的新输入')
    assert page.evaluate('window.__chatRequests.length') == 0, '重开不能重新调用模型'
    # 正常读取的已保存草稿仍免写，不能为修复重试而恢复每次离页写入。
    writes = page.evaluate('window.__draftWrites.writes')
    leave(page)
    page.wait_for_timeout(350)
    assert page.evaluate('window.__draftWrites.writes') == writes
    assert not errors, errors
    context.close()
    print('PASS chat save retry', action, 'reply' if reply else 'input', 'dark' if dark else 'light', flush=True)


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for action in ['leave', 'history', 'new']:
            run(browser, action)
        run(browser, 'leave', reply=True, dark=True)
        browser.close()
