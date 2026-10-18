"""首页模块排序、快捷配置和模板入口，全部为隔离虚构数据。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/home-configuration'


# 在浏览器内保留第一组完整按钮，主动触发一次前台刷新后检查节点和焦点。
STARTUP_SHORTCUT_PROBE = '''() => {
  const probe = window.__homeShortcutProbe = {
    buttons: null, focused: null, monthRenders: 0, timelineRenders: 0, reminderRenders: 0,
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList' && record.target.id === 'm-spend') probe.monthRenders++;
      if (record.type === 'childList' && record.target.id === 'hm-days') probe.timelineRenders++;
      if (record.type === 'attributes' && record.target.id === 'hm-reminders') probe.reminderRenders++;
    }
    const buttons = [...document.querySelectorAll('#hm-quick button')];
    if (!probe.buttons && buttons.length === 6 && buttons.at(-1).dataset.qa === 'all') {
      probe.buttons = buttons;
      probe.focused = buttons[0];
      probe.focused.focus();
    }
  });
  observer.observe(document, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'],
  });
  probe.stop = () => observer.disconnect();
}'''


def assert_startup_shortcuts(page, width):
    page.wait_for_selector('#hm-quick:not([hidden]) [data-qa="all"]')
    # 首次加载不再依赖 render/onShow 重复取数。先等首轮完成，
    # 再模拟回到前台，验证真实刷新仍保留同一组快捷按钮与焦点。
    page.wait_for_function('''() => {
      const probe = window.__homeShortcutProbe;
      return probe?.buttons && probe.monthRenders >= 1
        && probe.timelineRenders >= 1 && probe.reminderRenders >= 1;
    }''')
    target=page.evaluate('''() => {
      const probe=window.__homeShortcutProbe;
      const target=[probe.monthRenders+1,probe.timelineRenders+1,probe.reminderRenders+1];
      document.dispatchEvent(new Event('visibilitychange'));
      return target;
    }''')
    page.wait_for_function('''target => {
      const probe=window.__homeShortcutProbe;
      return probe.monthRenders>=target[0] && probe.timelineRenders>=target[1] && probe.reminderRenders>=target[2];
    }''',arg=target)
    snapshot = page.evaluate('''() => {
      const probe = window.__homeShortcutProbe;
      probe.stop();
      const buttons = [...document.querySelectorAll('#hm-quick button')];
      return {
        viewport: {width: innerWidth, height: innerHeight},
        readyState: document.readyState,
        renders: {month: probe.monthRenders, timeline: probe.timelineRenders, reminders: probe.reminderRenders},
        originalConnected: probe.buttons.map(button => button.isConnected),
        originalIdentity: probe.buttons.map((button, index) => button === buttons[index]),
        focusRetained: document.activeElement === probe.focused,
        // 查询当前节点与测量放在同一个 JS 任务，不能测到 evaluate_all 的陈旧句柄。
        buttons: buttons.map(button => {
          const style = getComputedStyle(button);
          return {
            text: button.textContent.trim(), ...button.getBoundingClientRect().toJSON(),
            isConnected: button.isConnected, parentConnected: button.parentElement?.isConnected,
            display: style.display, visibility: style.visibility,
            minWidth: style.minWidth, minHeight: style.minHeight, transform: style.transform,
          };
        }),
      };
    }''')
    assert snapshot['viewport']['width'] == width, snapshot
    assert all(snapshot['originalConnected']), ('同布局刷新不应移除快捷按钮', snapshot)
    assert all(snapshot['originalIdentity']), ('同布局刷新应保留快捷按钮节点', snapshot)
    assert snapshot['focusRetained'], ('同布局刷新不应丢失快捷按钮焦点', snapshot)
    quick_buttons = snapshot['buttons']
    assert len(quick_buttons) == 6, snapshot
    assert quick_buttons[-1]['text'] == '全部', snapshot
    assert abs(quick_buttons[-1]['top'] - quick_buttons[0]['top']) < 1, ('“全部”不应另起一行', snapshot)
    assert all(button['isConnected'] and button['parentConnected'] for button in quick_buttons), snapshot
    assert all(button['width'] >= 43 and button['height'] >= 43 for button in quick_buttons), snapshot


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1024):
            ctx = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block')
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.add_init_script(f'({STARTUP_SHORTCUT_PROBE})()')
            page.goto(URL)
            assert_startup_shortcuts(page, width)
            assert page.locator('#hm-quick .qa').count() == 5
            page.click('#btn-home-edit')
            page.wait_for_selector('[data-sw="today"]')
            page.click('[data-move="quick"][data-step="-1"]')
            page.wait_for_function("document.querySelector('#homeedit-list [data-mod]')?.dataset.mod === 'quick'")
            page.click('[data-quick="ai"]')
            page.wait_for_selector('[data-quick="ai"][aria-checked="false"]')
            page.click('[data-quick="budget"]')
            page.wait_for_selector('[data-quick="budget"][aria-checked="true"]')
            page.wait_for_timeout(350)
            page.screenshot(path=str(OUT / f'config-{width}.png'))
            page.click('#sp-home-custom .sub-head [data-act="back"]')
            page.wait_for_selector('#sp-home-custom', state='detached')
            page.wait_for_selector('#hm-quick [data-qa="budget"]')
            assert page.locator('#hm-quick .qa').count() == 5
            assert page.locator('#hm-quick').bounding_box()['y'] < page.locator('#hm-month').bounding_box()['y']
            page.click('#hm-quick [data-qa="note"]')
            page.wait_for_selector('#sp-template-manage.open')
            page.click('#sp-template-manage .sub-head [data-act="back"]')
            page.wait_for_selector('#sp-template-manage', state='detached')
            page.wait_for_timeout(350)
            page.screenshot(path=str(OUT / f'home-{width}.png'))
            assert not errors, errors
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            page.reload()
            page.wait_for_selector('#hm-quick [data-qa="budget"]')
            assert page.locator('#hm-quick').bounding_box()['y'] < page.locator('#hm-month').bounding_box()['y']
            print(f'PASS home configuration, persistence, empty template {width}', flush=True)
            ctx.close()
        browser.close()
if __name__ == '__main__': main()
