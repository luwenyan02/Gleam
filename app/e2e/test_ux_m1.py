# -*- coding: utf-8 -*-
"""M1 快速记账工作台交互验收。"""

import os
import sys
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4173/')
SCREENSHOTS = Path(os.environ.get(
    'GLEAM_E2E_SCREENSHOTS',
    Path(__file__).parents[2] / '.tmp' / 'tests' / 'e2e' / 'screenshots',
))
SCREENSHOTS.mkdir(parents=True, exist_ok=True)


def assert_advanced_action_row(page) -> None:
    selectors = ['[data-tpl-manage]', '#chip-tag', '#chip-shop', '#life-toggle']
    buttons = [page.locator(selector) for selector in selectors]
    boxes = [button.bounding_box() for button in buttons]
    assert all(box is not None for box in boxes), '四个记账入口均须可见'
    assert max(box['y'] for box in boxes) - min(box['y'] for box in boxes) < 1, '四个记账入口应在同一行'
    for button, box in zip(buttons, boxes):
        assert box['width'] >= 44 and box['height'] >= 44, '记账入口须保持触控范围'
        assert button.evaluate('e=>e.scrollWidth<=e.clientWidth+1'), '记账入口不能截断操作文字'
    assert page.locator('#advanced-fields').evaluate('e=>e.scrollWidth<=e.clientWidth+1')


def assert_basic_workspace(page, width: int, height: int) -> None:
    page.goto(URL)
    page.wait_for_load_state('networkidle')
    page.wait_for_selector('.tabbar', timeout=15_000)

    labels = page.locator('.tabbar .tab, .tabbar #fab').all_inner_texts()
    joined = ''.join(item.replace('\n', '') for item in labels)
    assert '账户' in joined and '报表' in joined and '拾光' in joined and '我的' in joined

    page.click('#fab')
    page.wait_for_selector('#sheet.open.entry-workspace #keypad', timeout=10_000)
    page.wait_for_timeout(400)

    sheet = page.locator('#sheet')
    box = sheet.bounding_box()
    assert box is not None
    assert box['height'] >= height - 2, f'{width}x{height}: 工作台未占满视口，实际高度 {box["height"]}'
    assert box['y'] <= 1, f'{width}x{height}: 工作台顶部未贴齐视口，y={box["y"]}'

    visible_categories = page.locator('#cat-grid .cat[data-id]:visible')
    assert visible_categories.count() == 7, f'{width}x{height}: 首屏常用分类应为 7 个'
    assert page.locator('#cat-grid [data-cat-more]:visible').count() == 1
    assert page.locator('#mark-bx:visible').count() == 1, '报销应保留在支出首屏常用区'
    assert page.locator('#advanced-fields').get_attribute('hidden') is not None

    metrics = page.evaluate('''() => {
      const viewportH = window.innerHeight;
      const selectors = ['#cat-grid', '#note', '#date-chip', '#acct-btn', '#keypad'];
      return {
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        visible: selectors.map((selector) => {
          const el = document.querySelector(selector);
          const rect = el?.getBoundingClientRect();
          return { selector, top: rect?.top ?? -1, bottom: rect?.bottom ?? viewportH + 1 };
        }),
      };
    }''')
    assert not metrics['horizontalOverflow'], f'{width}x{height}: 存在横向溢出'
    for item in metrics['visible']:
        assert item['top'] >= 0 and item['bottom'] <= height + 1, (
            f'{width}x{height}: {item["selector"]} 首屏不可见，{item}'
        )

    if width in (390, 1024):
        page.screenshot(path=str(SCREENSHOTS / f'm1-workspace-{width}x{height}.png'))

    page.click('#keypad button[data-k="2"]')
    page.click('#keypad button[data-k="8"]')
    amount_before = page.inner_text('#amt')
    page.click('[data-act="toggle-advanced"]')
    assert page.locator('#advanced-fields').get_attribute('hidden') is None
    assert page.inner_text('#amt') == amount_before, '展开高级项不应丢失金额草稿'
    assert_advanced_action_row(page)

    page.click('[data-act="toggle-advanced"]')
    assert page.locator('#advanced-fields').get_attribute('hidden') is not None
    assert page.inner_text('#amt') == amount_before, '收起高级项不应丢失金额草稿'


def main() -> int:
    failures = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for width, height in ((360, 800), (390, 844), (430, 932), (1024, 900)):
            context = browser.new_context(
                viewport={'width': width, 'height': height},
                service_workers='block',
            )
            page = context.new_page()
            page.on('pageerror', lambda error: print(f'PAGEERROR: {error}', flush=True))
            try:
                assert_basic_workspace(page, width, height)
                print(f'PASS M1 workspace {width}x{height}', flush=True)
            except Exception as error:  # noqa: BLE001 - test runner must aggregate failures
                failures.append(f'{width}x{height}: {error}\n{traceback.format_exc()}')
                page.screenshot(path=str(SCREENSHOTS / f'm1-workspace-{width}x{height}-fail.png'))
                print(f'FAIL M1 workspace {width}x{height}: {error}', flush=True)
            finally:
                context.close()
        browser.close()

    if failures:
        print('\n'.join(failures[-4:]))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
