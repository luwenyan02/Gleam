"""Swiping to copy/edit replaces the prefilled amount on first numeric input."""
import os
from playwright.sync_api import sync_playwright, expect
from test_entry_copy_edit import SEED, rows

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')


def open_action(page, action):
    # Home may finish a debounced refresh after closing the previous draft.
    page.locator('#hm-days').evaluate('''el => new Promise(resolve => {
      let timer;
      const done = () => { observer.disconnect(); resolve(); };
      const settle = () => { clearTimeout(timer); timer = setTimeout(done, 200); };
      const observer = new MutationObserver(settle);
      observer.observe(el, {childList: true, subtree: true}); settle();
    })''')
    row = page.locator('#hm-days [data-entry-row="8101"]')
    row.scroll_into_view_if_needed()
    box = row.locator('.entry-swipe-content').bounding_box()
    x, y = box['x'] + box['width'] - 12, box['y'] + box['height'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x - 240, y, steps=12)
    page.mouse.up()
    expect(row).to_have_class('entry-swipe swipe-open')
    row.locator(f'[data-entry-action="{action}"]').click()
    page.locator('#sheet.open #keypad').wait_for()
    expect(page.locator('#amt')).to_have_text('13.1')


def key(page, value):
    page.locator(f'#keypad [data-k="{value}"]').click()


def close(page):
    page.locator('#sheet-close').click()
    page.locator('#sheet.open').wait_for(state='detached')


def run(browser, width):
    context = browser.new_context(viewport={'width': width, 'height': 844},
                                  timezone_id='Asia/Shanghai', service_workers='block')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL)
    page.locator('#fab').wait_for()
    page.evaluate(SEED.replace('amount:3680', 'amount:1310'), 'light')
    page.reload()
    page.locator('#hm-days [data-entry="8101"]').wait_for()
    originals = rows(page)
    cases = [
        (('1', '2'), '12'),
        (('0', '2'), '2'),
        (('.', '5'), '0.5'),
        (('1', '.', '2', '3', '4'), '1.23'),
        (('del', '2'), '13.2'),
        (('+', '2', '='), '15.1'),
        (('=', '2'), '13.12'),
        (('clear', '2', '3'), '23'),
    ]
    for action in ('copy', 'edit'):
        for keys, expected in cases:
            open_action(page, action)
            # Other fields do not consume the pending first-input replacement.
            page.locator('#note').fill('虚构修改备注')
            page.locator('#note').blur()
            for index, value in enumerate(keys):
                key(page, value)
                if keys == ('1', '2') and index == 0:
                    expect(page.locator('#amt')).to_have_text('1')
            expect(page.locator('#amt')).to_have_text(expected)
            close(page)
            assert rows(page) == originals, 'Cancelling must leave every original entry unchanged'

        open_action(page, action)
        key(page, '1')
        expect(page.locator('#amt')).to_have_text('1')
        key(page, 'save')
        page.locator('#sheet.open').wait_for(state='detached')
        saved = rows(page)
        if action == 'copy':
            copied = max(saved, key=lambda row: row['id'])
            assert copied['amount'] == 100 and len(saved) == len(originals) + 1
            assert [row for row in saved if row['id'] in range(8101, 8105)] == originals
        else:
            assert next(row for row in saved if row['id'] == 8101)['amount'] == 100
        originals = saved
    # A normal new draft keeps appending digits as before.
    page.locator('#fab').click()
    page.locator('#sheet.open #keypad').wait_for()
    key(page, '1')
    key(page, '2')
    expect(page.locator('#amt')).to_have_text('12')
    close(page)
    assert not errors, errors
    context.close()
    print('PASS swipe copy/edit first input replaces amount', width, flush=True)


if __name__ == '__main__':
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1280):
            run(browser, width)
        browser.close()
