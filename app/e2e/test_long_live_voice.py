"""长实时转写的真实浏览器回归：仅合成原生桥，不访问音频或外部模型。"""
import os
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from test_browser_usability import assert_usable
from test_entry_receipts import image as receipt_image
from test_life_ai import URL, configure, read_rows
from test_native_live_voice import MOCK, assert_inline
from test_voice_markdown import DISPLAY, RAW, start, wait_saved


OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/long-live-voice'
TABLE = ('| ' + ' | '.join(f'虚构表格第{i}列' for i in range(12)) + ' |\n'
         '| ' + ' | '.join(['---'] * 12) + ' |\n'
         '| ' + ' | '.join(['面包、鸡蛋或水果'] * 12) + ' |')
LONG = '长回复开头标记。' + '这是一段虚构的长实时语音原文。' * 430 + '长回复中间标记。' + '需要完整保留原话而不是截断。' * 430 + '长回复结尾标记。'
FIRST = '首条用户原话，保留选区和历史节点。'
CANCELLED = '取消时已经收到的原文。结束桥最后100毫秒原文。'
WATCH_WRITES = r'''(() => {
  window.__draftWrites = []; window.__ledgerWrites = [];
  for (const method of ['put', 'add', 'delete', 'clear']) {
    const original = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function(...args) {
      const name = this.name, messages = args[0]?.messages;
      const event = {count: messages?.length ?? 0, tail: messages?.at(-1)?.content ?? ''};
      const request = original.apply(this, args);
      this.transaction.addEventListener('complete', () => {
        event.at = performance.now();
        if (name === 'lifeDrafts' && method === 'put') window.__draftWrites.push(event);
        if (['entries', 'accounts'].includes(name)) window.__ledgerWrites.push({name, method});
      }, {once: true});
      return request;
    };
  }
})();'''


def patch(page, messages, **event):
    page.evaluate('event => window.__liveEvent(event)',
                  {'state': 'speaking', 'transcriptMode': 'upsert', 'messages': messages, **event})


def message(identity, order, role, content, complete=False):
    return {'id': identity, 'order': order, 'role': role, 'content': content, 'complete': complete}


def pending_end(page, final, delay=100, ordinary_late=False):
    page.evaluate('''({final, delay, ordinaryLate}) => {
      const original = window.Capacitor.nativePromise;
      window.Capacitor.nativePromise = async (plugin, method, options) => {
        const result = await original(plugin, method, options);
        if (plugin === 'GleamLiveVoice' && method === 'end') {
          window.Capacitor.nativePromise = original;
          await new Promise(resolve => {
            if (ordinaryLate) setTimeout(() => window.__liveEvent({sessionId:options.sessionId, transcriptMode:'upsert', messages:[{
              id:'ordinary-late', order:2, role:'assistant', content:'关闭后的普通迟到污染文字'
            }]}), 20);
            window.__finishClosingVoice = () => {
              window.__liveEvent({sessionId:options.sessionId, transcriptMode:'upsert', finalTranscript:true, messages:[final]});
              resolve();
            };
            if (delay !== null) setTimeout(window.__finishClosingVoice, delay);
          });
        }
        return result;
      };
    }''', {'final': final, 'delay': delay, 'ordinaryLate': ordinary_late})


def open_chat(page):
    page.locator('#fab').wait_for()
    page.locator('[data-page="page-life"]').click()
    page.locator('[data-life-chat]').click()


def has_text(row, text):
    return any(item.get('content') == text for item in row.get('messages', []))


def appearance(page, theme, scale):
    page.evaluate('''([theme, scale]) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--seed-type', scale);
    }''', [theme, str(scale)])


def assert_reading_state(page):
    assert page.evaluate('''() => {
      const selection = getSelection();
      return window.__oldUser.isConnected && window.__oldTable.isConnected
        && document.querySelector('.user') === window.__oldUser
        && document.querySelector('.chat-table-scroll') === window.__oldTable
        && selection.toString() === window.__selected
        && selection.anchorNode === window.__selectionNode
        && Math.abs(window.__oldTable.scrollLeft - window.__tableLeft) < 1;
    }'''), 'Later patches replaced historical DOM, selection or table position'


def run(browser, width, height, theme, scale):
    context = browser.new_context(viewport={'width': width, 'height': height},
                                  service_workers='block', reduced_motion='reduce',
                                  timezone_id='Asia/Shanghai')
    page = context.new_page()
    page.add_init_script(MOCK)
    page.add_init_script(WATCH_WRITES)
    page.add_init_script('Object.defineProperty(navigator,"clipboard",{value:{writeText:async text=>{window.__copied=text}}})')
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://**/*', lambda route: (external.append(route.request.url), route.abort()))
    OUT.mkdir(parents=True, exist_ok=True)
    name = f'{width}-{theme}-{scale}'
    try:
        page.goto(URL)
        page.locator('#fab').wait_for()
        configure(page)
        open_chat(page)
        appearance(page, theme, scale)
        ledger = {table: read_rows(page, table) for table in ['entries', 'accounts']}
        page.evaluate('window.__ledgerWrites = []')
        page.locator('#life-chat-input').fill('保留的虚构未发送文字')
        start(page)

        # A real old-build RED: the second patch used to erase both older messages.
        patch(page, [message('first', 1, 'user', FIRST), message('table', 2, 'assistant', TABLE, True)])
        expect(page.locator('.life-chat-bubble')).to_have_count(2)
        patch(page, [message('third', 3, 'user', '第二批用户文字')])
        expect(page.locator('.life-chat-bubble')).to_have_count(3)
        expect(page.locator('.user .chat-message-text').first).to_have_text(FIRST)
        expect(page.locator('.assistant table')).to_have_count(1)

        # Native placeholders reserve ordering while the user ASR arrives late.
        patch(page, [message('late-user', 4, 'user', ''),
                     message('early-answer', 5, 'assistant', '助手先收到的回复。')])
        patch(page, [message('late-user', 4, 'user', '迟到的用户原话应在助手之前。', True)])
        expect(page.locator('.life-chat-bubble')).to_have_count(5)
        assert page.locator('.life-chat-bubble').all_text_contents()[3].startswith('迟到的用户原话')
        assert '助手先收到的回复' in page.locator('.life-chat-bubble').nth(4).inner_text()

        # Save actual historical node identities, a DOM selection and horizontal scroll.
        page.locator('#life-chat-messages').evaluate('el => el.scrollTop = 0')
        page.evaluate('''() => {
          window.__oldUser = document.querySelector('.user');
          window.__oldTable = document.querySelector('.chat-table-scroll');
          window.__oldTable.scrollLeft = 72; window.__tableLeft = window.__oldTable.scrollLeft;
          const walker = document.createTreeWalker(window.__oldUser.querySelector('.chat-message-text'), NodeFilter.SHOW_TEXT);
          window.__selectionNode = walker.nextNode();
          const range = document.createRange(); range.setStart(window.__selectionNode, 0); range.setEnd(window.__selectionNode, 8);
          getSelection().removeAllRanges(); getSelection().addRange(range); window.__selected = getSelection().toString();
        }''')
        assert page.evaluate('window.__oldTable.scrollWidth > window.__oldTable.clientWidth')

        # More than 120 messages and 24k text, supplied only as dirty patches.
        history = [message(f'h{i}', i + 6, 'user' if i % 2 == 0 else 'assistant',
                           f'虚构历史第{i}条。' + '连续语音历史必须保留完整原文。' * 18)
                   for i in range(130)]
        assert sum(len(item['content']) for item in history) > 24_000
        for offset in range(0, len(history), 13):
            patch(page, history[offset:offset + 13])
            if offset == 0:
                expect(page.locator('.life-chat-bubble')).to_have_count(18)
                page.locator('#life-chat-messages').evaluate('el => el.scrollTop = 0')
        expect(page.locator('.life-chat-bubble')).to_have_count(135)
        expect(page.locator('#life-chat-messages')).to_contain_text('虚构历史第0条。')
        expect(page.locator('#life-chat-messages')).to_contain_text('虚构历史第65条。')
        expect(page.locator('#life-chat-messages')).to_contain_text('虚构历史第129条。')
        assert_reading_state(page)
        assert page.locator('#life-chat-messages').evaluate('el => el.scrollTop') < 2

        # A single >12k turn remains raw and must never trigger optional model layout.
        assert len(LONG) > 12_000
        long_reply = message('long', 136, 'assistant', LONG, True)
        long_reply['search'] = {'status': 'searched', 'sources': [
            {'title': '隐藏的虚构长语音来源', 'url': 'https://source.invalid/long-voice'}]}
        patch(page, [long_reply])
        expect(page.locator('.assistant .chat-message-text').last).to_have_text(LONG)
        expect(page.locator('[data-chat-regenerate]')).to_be_disabled()
        expect(page.locator('.assistant [data-chat-copy]').last).to_be_enabled()
        assert_reading_state(page)
        page.locator('#life-chat-messages').evaluate('el => el.scrollTop = el.scrollHeight')
        assert_inline(page)
        assert_usable(page, '#sp-life-chat')
        page.screenshot(path=str(OUT / f'long-{name}.png'), animations='disabled')
        page.locator('.assistant [data-chat-copy]').last.click()
        page.wait_for_function('text => window.__copied === text', arg=LONG)
        expect(page.locator('.user button')).to_have_count(0)
        expect(page.locator('[data-chat-search],.chat-web-search,.chat-search-sources')).to_have_count(0)
        expect(page.locator('#life-chat-messages')).not_to_contain_text('隐藏的虚构长语音来源')

        # Keep emitting for >3 seconds: a trailing debounce would produce zero writes.
        page.evaluate('''() => {
          window.__draftWrites = []; window.__patchStarted = performance.now(); window.__tick = 0;
          window.__patchTimer = setInterval(() => {
            const tick = ++window.__tick;
            window.__liveEvent({state:'speaking', transcriptMode:'upsert', messages:[{
              id:'stream', order:137, role:'assistant', content:'持续增量检查点 ' + tick, complete:false
            }]});
          }, 70);
        }''')
        page.wait_for_timeout(3400)
        writes = page.evaluate('window.__draftWrites')
        live_writes = [item for item in writes if item['tail'].startswith('持续增量检查点 ')]
        assert len(live_writes) >= 3, live_writes
        started = page.evaluate('window.__patchStarted')
        assert live_writes[0]['at'] - started < 1400, live_writes
        assert max(b['at'] - a['at'] for a, b in zip(live_writes, live_writes[1:])) < 1400, live_writes
        page.evaluate('clearInterval(window.__patchTimer)')
        last_stream = page.locator('.assistant .chat-message-text').last.inner_text()
        page.locator('[data-voice-interrupt]').click()
        expect(page.locator('.assistant .chat-message-text').last).to_have_text(last_stream)

        # Explicit end must flush the last patch; the previous session cannot pollute a new one.
        old_session = page.evaluate('window.__liveSession')
        patch(page, [message('stream', 137, 'assistant', '结束前最后一帧原文。')])
        page.locator('[data-voice-end]').click()
        expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        wait_saved(page, lambda row: has_text(row, '结束前最后一帧原文。') and has_text(row, LONG) and len(row['messages']) == 137)
        start(page)
        patch(page, [message('first', 1, 'user', '新语音会话仍可复用桥ID。')])
        patch(page, [message('pollution', 138, 'assistant', '旧会话污染文字')], sessionId=old_session)
        patch(page, [message('pollution-end', 139, 'assistant', '旧结束事件污染文字')], sessionId=old_session, state='ended')
        expect(page.locator('#life-chat-messages')).not_to_contain_text('污染文字')
        expect(page.locator('[data-voice-mute]')).to_be_visible()
        expect(page.locator('#life-chat-messages')).to_contain_text(FIRST)
        patch(page, [message('background', 2, 'assistant', '后台前最后一帧原文。')])
        page.evaluate('Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});document.dispatchEvent(new Event("visibilitychange"))')
        wait_saved(page, lambda row: has_text(row, '后台前最后一帧原文。') and has_text(row, LONG))
        page.evaluate('delete document.hidden;document.dispatchEvent(new Event("visibilitychange"))')
        expect(page.locator('[data-voice-start]')).to_be_visible()
        page.locator('[data-voice-close]').click()

        # Closing during a partial reply keeps all text and flushes it as well.
        start(page)
        patch(page, [message('cancel', 1, 'assistant', '取消时已经收到的原文。')])
        pending_end(page, message('cancel', 1, 'assistant', CANCELLED), ordinary_late=True)
        page.locator('[data-voice-close]').click()
        wait_saved(page, lambda row: has_text(row, CANCELLED))
        expect(page.locator('#life-chat-messages')).not_to_contain_text('关闭后的普通迟到污染文字')
        expect(page.locator('#life-chat-messages')).to_contain_text(CANCELLED)

        # Keep message-index operations blocked until A's final flush has settled.
        start(page)
        patch(page, [message('a-user', 1, 'user', 'A会话结束前已有文字。')])
        pending_end(page, message('a-final', 2, 'assistant', 'A结束桥迟到新增条目。'), delay=None)
        page.locator('[data-voice-close]').click()
        expect(page.locator('[data-chat-voice]')).to_be_disabled()
        expect(page.locator('[data-life-chat-send]')).to_be_disabled()
        expect(page.locator('[data-chat-start]')).to_be_disabled()
        page.evaluate('window.__finishClosingVoice()')
        expect(page.locator('#life-chat-messages')).to_contain_text('A结束桥迟到新增条目。')
        expect(page.locator('[data-chat-voice]')).to_be_enabled()
        expect(page.locator('[data-life-chat-send]')).to_be_enabled()
        start(page)
        patch(page, [message('b-user', 1, 'user', 'B新会话已有文字不能丢失。')])
        expect(page.locator('.life-chat-bubble').filter(has_text='B新会话已有文字不能丢失。')).to_have_count(1)
        patch(page, [message('b-answer', 2, 'assistant', 'B继续回复时A末批也不能丢失。')])
        page.locator('[data-voice-end]').click()
        wait_saved(page, lambda row: all(has_text(row, text) for text in [
            'A结束桥迟到新增条目。', 'B新会话已有文字不能丢失。', 'B继续回复时A末批也不能丢失。']))
        assert not page.evaluate('window.__ledgerWrites')
        assert not page.evaluate('window.__aiStreamCalls')
        page.reload()
        open_chat(page)
        appearance(page, theme, scale)
        expect(page.locator('#life-chat-messages')).to_contain_text(FIRST)
        expect(page.locator('#life-chat-messages')).to_contain_text('虚构历史第65条。')
        expect(page.locator('#life-chat-messages')).to_contain_text('虚构历史第129条。')
        expect(page.locator('#life-chat-messages')).to_contain_text('长回复开头标记。')
        expect(page.locator('#life-chat-messages')).to_contain_text('长回复中间标记。')
        expect(page.locator('#life-chat-messages')).to_contain_text('长回复结尾标记。')
        expect(page.locator('#life-chat-messages')).to_contain_text(CANCELLED)
        expect(page.locator('#life-chat-input')).to_have_value('保留的虚构未发送文字')
        expect(page.locator('.chat-voice-overlay')).to_have_count(0)
        saved = next(row for row in read_rows(page, 'lifeDrafts') if has_text(row, LONG))
        assert len(saved['messages']) == 144
        assert all(has_text(saved, item['content']) for item in history)
        assert has_text(saved, FIRST) and has_text(saved, '后台前最后一帧原文。')
        assert next(item for item in saved['messages'] if item['content'] == LONG)['search'] == long_reply['search']

        # Legacy bridges without transcriptMode continue to send replacement snapshots.
        start(page)
        page.evaluate('window.__liveEvent({messages:[{role:"user",content:"旧桥用户文字"}]})')
        page.evaluate('window.__liveEvent({messages:[{role:"user",content:"旧桥用户文字"},{role:"assistant",content:"旧桥助手文字"}]})')
        expect(page.locator('.life-chat-bubble')).to_have_count(146)
        page.locator('[data-voice-end]').click()
        wait_saved(page, lambda row: has_text(row, '旧桥助手文字') and has_text(row, LONG))
        assert_usable(page, '#sp-life-chat')
        page.screenshot(path=str(OUT / f'restored-{name}.png'), animations='disabled')
        assert all(read_rows(page, table) == rows for table, rows in ledger.items())
        assert not page.evaluate('window.__ledgerWrites')
        assert not page.evaluate('window.__aiStreamCalls')
        assert page.evaluate('window.__micCalls') == 0
        assert not external and not errors, (external, errors)
        print('PASS long live voice: upserts, 144-message raw history, stable DOM, fixed checkpoints, flush and restore', name, flush=True)
    except Exception:
        page.screenshot(path=str(OUT / f'failure-{name}.png'), animations='disabled')
        raise
    finally:
        context.close()


def run_layout(browser, width, height, theme, scale):
    """Only this isolated case permits one locally fulfilled formatting request."""
    OUT.mkdir(parents=True, exist_ok=True)
    context = browser.new_context(viewport={'width': width, 'height': height},
                                  service_workers='block', reduced_motion='reduce')
    page = context.new_page()
    page.add_init_script(MOCK)
    page.add_init_script(WATCH_WRITES)
    held, payloads, external, errors = [], [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://**/*', lambda route: (external.append(route.request.url), route.abort()))

    def layout(route):
        payloads.append(route.request.post_data_json)
        held.append(route)

    page.route('https://life-ai.invalid/**', layout)
    name = f'{width}-{theme}-{scale}'
    try:
        page.goto(URL)
        page.locator('#fab').wait_for()
        configure(page)
        open_chat(page)
        appearance(page, theme, scale)
        ledger = {table: read_rows(page, table) for table in ['entries', 'accounts']}
        page.evaluate('window.__ledgerWrites = []')
        start(page)
        patch(page, [message('layout-user', 1, 'user', '虚构排版与附件重绘检查。'),
                     message('layout-answer', 2, 'assistant', RAW, True)])
        until = time.monotonic() + 5
        while not held and time.monotonic() < until:
            page.wait_for_timeout(30)
        assert len(held) == len(payloads) == 1
        page.locator('[data-voice-end]').click()
        expect(page.locator('[data-chat-voice]')).to_be_enabled()
        page.locator('[data-life-chat-photo]').click()
        page.locator('#lchat-file').set_input_files(receipt_image(page, '虚构待发照片.png', '#a76834'))
        expect(page.locator('[data-life-chat-remove-photo]')).to_have_count(1)
        page.locator('[data-life-chat-remove-photo]').click()
        expect(page.locator('[data-life-chat-remove-photo]')).to_have_count(0)
        held.pop().fulfill(json={'choices': [{'message': {'content': DISPLAY}}]})
        expect(page.locator('.assistant strong').first).to_have_text('周六')
        expect(page.locator('.life-chat-bubble')).to_have_count(2)
        expect(page.locator('.user .chat-message-text')).to_have_text('虚构排版与附件重绘检查。')
        expect(page.locator('.assistant .chat-message-text')).to_have_count(1)
        wait_saved(page, lambda row: len(row['messages']) == 2 and any(
            item.get('content') == RAW and item.get('voiceDisplay') == DISPLAY for item in row['messages']))
        assert_usable(page, '#sp-life-chat')
        page.screenshot(path=str(OUT / f'layout-after-photos-{name}.png'), animations='disabled')
        assert len(payloads) == 1 and not external and not errors, (len(payloads), external, errors)
        assert all(read_rows(page, table) == rows for table, rows in ledger.items())
        assert not page.evaluate('window.__ledgerWrites')
        assert page.evaluate('window.__micCalls') == 0
        print('PASS delayed synthetic layout after voice end and attachment redraw', name, flush=True)
    except Exception:
        page.screenshot(path=str(OUT / f'failure-layout-{name}.png'), animations='disabled')
        raise
    finally:
        context.close()


if __name__ == '__main__':
    profiles = [(360, 760, 'light', 1), (390, 844, 'dark', 1),
                (430, 932, 'light', 1), (390, 560, 'dark', 1.3), (1280, 900, 'dark', 1)]
    if os.environ.get('GLEAM_E2E_PROFILE') == '390':
        profiles = [profiles[1]]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for profile in profiles:
            if os.environ.get('GLEAM_E2E_SCENARIO') != 'layout':
                run(browser, *profile)
            run_layout(browser, *profile)
        browser.close()
