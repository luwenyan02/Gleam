"""Keypad layout, immediate press feedback and single-activation save regression."""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/entry-keypad'


def count_entries(page):
    return page.evaluate('''async () => {
      const db = await new Promise(resolve => {
        const req = indexedDB.open('GleamDB'); req.onsuccess = () => resolve(req.result);
      });
      const count = await new Promise(resolve => {
        const req = db.transaction('entries').objectStore('entries').count();
        req.onsuccess = () => resolve(req.result);
      }); db.close(); return count;
    }''')


def run(page, name, theme, scale, touch):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script('''window.__taps = [];
      Object.defineProperty(navigator, 'vibrate', {value: ms => {window.__taps.push(ms); return true;}});
    ''')
    page.goto(URL)
    page.locator('#fab').wait_for()
    page.evaluate('''([theme, scale, touch]) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--seed-type', scale);
      if (touch) document.documentElement.style.setProperty('--safe-bottom', '20px');
    }''', [theme, scale, touch])
    page.locator('#fab').click()
    keypad = page.locator('#sheet.open #keypad')
    keypad.wait_for()
    page.wait_for_timeout(350)
    metrics = keypad.evaluate('''el => {
      const box = key => el.querySelector(`[data-k="${key}"]`).getBoundingClientRect().toJSON();
      return {gap: parseFloat(getComputedStyle(el).gap), bounds: el.getBoundingClientRect().toJSON(),
        one: box('1'), two: box('2'), four: box('4'), save: box('save'), zero: box('0'), clear: box('clear'),
        keyboard: el.closest('.entry-keyboard').getBoundingClientRect().toJSON(),
        buttons: [...el.querySelectorAll('button')].map(b => b.getBoundingClientRect().toJSON())};
    }''')
    assert metrics['gap'] <= 1, metrics
    assert abs(metrics['clear']['top'] - metrics['zero']['top']) < 1, metrics
    assert abs(metrics['clear']['right'] + metrics['gap'] - metrics['zero']['left']) < 1, metrics
    assert abs(metrics['zero']['width'] - metrics['one']['width']) < 1, metrics
    assert abs(metrics['keyboard']['height'] - metrics['bounds']['height']) < 1, metrics
    assert metrics['save']['height'] >= metrics['one']['height'] * 2
    assert abs(metrics['save']['bottom'] - metrics['zero']['bottom']) < 1
    assert metrics['bounds']['bottom'] <= page.viewport_size['height'] + 1
    assert abs(metrics['bounds']['bottom'] - page.viewport_size['height']) < 1
    if touch:
        assert metrics['save']['bottom'] <= page.viewport_size['height'] - 19
    assert all(b['height'] >= 44 and b['width'] >= 44 for b in metrics['buttons'])
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(OUT / f'{name}-idle.png'), animations='disabled')

    one = keypad.locator('[data-k="1"]')
    idle = one.evaluate('el => getComputedStyle(el).backgroundColor')
    one.hover()
    page.mouse.down()
    assert one.evaluate('el => getComputedStyle(el).backgroundColor') != idle
    expect(page.locator('#amt')).to_have_text('0.00')  # Only click commits a digit.
    assert page.evaluate('window.__taps') == [12]
    page.screenshot(path=str(OUT / f'{name}-pressed.png'), animations='disabled')
    page.mouse.up()
    expect(page.locator('#amt')).to_have_text('1')
    assert page.evaluate('window.__taps') == [12]  # No second buzz on click.
    page.wait_for_timeout(150)
    assert one.evaluate('el => getComputedStyle(el).backgroundColor') == idle

    # Pointer cancellation outside the keyboard cannot append another digit.
    one.hover()
    page.mouse.down()
    page.mouse.move(5, 5)
    page.mouse.up()
    expect(page.locator('#amt')).to_have_text('1')
    two = keypad.locator('[data-k="2"]')
    two.focus()
    before = page.evaluate('window.__taps.length')
    two.press('Space')
    expect(page.locator('#amt')).to_have_text('12')
    assert page.evaluate('window.__taps.length') == before + 1

    # Saving disables controls while in flight; disabled controls do not buzz or input.
    two.evaluate('el => el.disabled = true')
    before = page.evaluate('window.__taps.length')
    two.dispatch_event('pointerdown', {'isPrimary': True, 'button': 0})
    two.dispatch_event('click')
    expect(page.locator('#amt')).to_have_text('12')
    assert page.evaluate('window.__taps.length') == before
    two.evaluate('el => el.disabled = false')

    for key in ('.', '3', '+', '4', '='):
        keypad.locator(f'[data-k="{key}"]').click()
    expect(page.locator('#amt')).to_have_text('16.3')
    initial = count_entries(page)
    keypad.locator('[data-k="again"]').click()
    expect(page.locator('#amt')).to_have_text('0.00')
    assert count_entries(page) == initial + 1
    for key in ('5', 'md', 'md', '2', '='):
        button = keypad.locator(f'[data-k="{key}"]')
        before = page.evaluate('window.__taps.length')
        if touch:
            button.tap()
        else:
            button.click()
        assert page.evaluate('window.__taps.length') == before + 1
    expect(page.locator('#amt')).to_have_text('2.5')
    keypad.locator('[data-k="save"]').click()
    page.locator('#sheet.open').wait_for(state='detached')
    assert count_entries(page) == initial + 2
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    profiles = [
        ('360-short', 360, 640, 'light', '1', False),
        ('390-light', 390, 844, 'light', '1', False),
        ('430-dark', 430, 932, 'dark', '1', False),
        ('400-large', 400, 890, 'light', '1.3', True),
        ('400-dark-large', 400, 890, 'dark', '1.3', True),
        ('desktop', 1280, 900, 'light', '1', False),
    ]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, width, height, theme, scale, touch in profiles:
            context = browser.new_context(viewport={'width': width, 'height': height},
                device_scale_factor=3 if touch else 1, has_touch=touch,
                reduced_motion='reduce' if name == '360-short' else 'no-preference',
                service_workers='block')
            page = context.new_page()
            page.set_default_timeout(10000)
            try:
                run(page, name, theme, scale, touch)
                print('PASS entry keypad', name, flush=True)
            except Exception:
                page.screenshot(path=str(OUT / f'{name}-failed.png'))
                raise
            finally:
                context.close()
        browser.close()
