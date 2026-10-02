"""Android feedback: local-time defaults, note classification and clean entry UI.

All browser contexts and ledger records are synthetic. No model request is needed.
"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

from test_browser_usability import assert_usable


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/entry-feedback'


def open_entry(page):
    page.locator('#fab').click()
    page.locator('#sheet.open #keypad').wait_for()
    page.wait_for_timeout(300)


def close_entry(page):
    page.locator('#sheet-close').click()
    page.locator('#sheet.open').wait_for(state='detached')
    page.wait_for_timeout(300)


def complete_note(page, text):
    page.locator('#note').fill(text)
    page.locator('#note').blur()


def seed_breakfast_history(page):
    page.evaluate('''async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(['entries', 'categories'], 'readwrite');
      const categories = await new Promise(resolve => {
        const request = tx.objectStore('categories').getAll();
        request.onsuccess = () => resolve(request.result);
      });
      const breakfast = categories.find(category => category.name === '早餐');
      for (let index = 0; index < 20; index++) {
        const occurred = new Date();
        occurred.setDate(occurred.getDate() - index - 1);
        occurred.setHours(8, 0, 0, 0);
        tx.objectStore('entries').put({
          id: index + 1, type: 'expense', amount: 1000, categoryId: breakfast.id,
          accountId: 1, occurredAt: occurred.getTime(), note: '虚构早餐',
          reimburseStatus: 'none', deletedAt: 0, createdAt: Date.now(), updatedAt: Date.now(),
        });
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }''')


def set_entry_hour(page, hour):
    page.locator('#date-chip').click()
    column = page.locator('.dw-col[aria-label="时"]')
    column.wait_for()
    column.focus()
    current = int(column.get_attribute('aria-valuenow'))
    for _ in range(abs(current - hour)):
        column.press('ArrowDown' if hour > current else 'ArrowUp')
    page.locator('.dw-confirm').click()
    page.locator('.dw-panel').wait_for(state='detached')


def run(page, width, timezone):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    # No need for a remote categorization service, even while composing notes.
    external = []
    page.route('https://**/*', lambda route: (external.append(route.request.url), route.abort()))
    page.goto(URL)
    page.locator('#fab').wait_for()
    local_evening = page.evaluate('new Date(2026, 9, 2, 21, 8).getTime()')
    page.clock.set_fixed_time(local_evening / 1000)
    open_entry(page)
    expect(page.locator('#pick-name')).to_have_text('晚餐')
    expect(page.locator('#date-txt')).to_contain_text('21:08')
    assert '按时段与历史推荐' not in page.locator('#sheet').inner_text()
    assert page.locator('#note-suggest,[data-note-idx]').count() == 0
    assert_usable(page, '#sheet')
    page.screenshot(path=str(OUT / f'evening-{width}-{timezone.replace("/", "-")}.png'), animations='disabled')

    # An incomplete composition and unknown/ambiguous text never guess a category.
    complete_note(page, '午')
    expect(page.locator('#pick-name')).to_have_text('晚餐')
    page.locator('#note').evaluate('''el => {
      el.focus();
      el.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
      el.value = '午餐';
      el.dispatchEvent(new InputEvent('input', {bubbles: true, isComposing: true}));
    }''')
    expect(page.locator('#pick-name')).to_have_text('晚餐')
    page.locator('#note').evaluate('''el => {
      el.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '午餐'}));
      el.blur();
    }''')
    expect(page.locator('#pick-name')).to_have_text('午餐')
    complete_note(page, '今天有一点普通的小事')
    expect(page.locator('#pick-name')).to_have_text('午餐')
    complete_note(page, '午餐和咖啡')
    expect(page.locator('#pick-name')).to_have_text('午餐')
    complete_note(page, '地铁回家')
    expect(page.locator('#pick-name')).to_have_text('地铁')
    complete_note(page, '喝咖啡')
    expect(page.locator('#pick-name')).to_have_text('咖啡')
    page.screenshot(path=str(OUT / f'note-match-{width}-{timezone.replace("/", "-")}.png'), animations='disabled')

    # Explicit category wins over matching notes and changed bill time.
    # This tap also blurs the note; matching must not replace its DOM before click.
    page.locator('#note').fill('午餐')
    page.locator('#cat-grid .cat').filter(has_text='早餐').click()
    expect(page.locator('#pick-name')).to_have_text('早餐')
    complete_note(page, '坐地铁回家')
    expect(page.locator('#pick-name')).to_have_text('早餐')
    set_entry_hour(page, 12)
    expect(page.locator('#pick-name')).to_have_text('早餐')
    complete_note(page, '午饭')
    expect(page.locator('#pick-name')).to_have_text('早餐')
    page.locator('#seg [data-type="income"]').click()
    complete_note(page, '发工资')
    expect(page.locator('#pick-name')).to_have_text('工资')
    page.locator('#seg [data-type="expense"]').click()
    complete_note(page, '坐地铁')
    expect(page.locator('#pick-name')).to_have_text('早餐')

    # Events from an old detached input must not mutate the next entry session.
    page.evaluate("window.__oldNote = document.querySelector('#note')")
    close_entry(page)
    open_entry(page)
    expect(page.locator('#pick-name')).to_have_text('晚餐')
    page.evaluate('''() => {
      window.__oldNote.value = '午餐';
      window.__oldNote.dispatchEvent(new Event('input', {bubbles: true}));
      window.__oldNote.dispatchEvent(new Event('blur'));
    }''')
    expect(page.locator('#pick-name')).to_have_text('晚餐')
    set_entry_hour(page, 12)
    expect(page.locator('#pick-name')).to_have_text('午餐')
    set_entry_hour(page, 8)
    expect(page.locator('#pick-name')).to_have_text('早餐')
    close_entry(page)

    # A large breakfast-only history cannot make 21:08 default to breakfast.
    seed_breakfast_history(page)
    open_entry(page)
    expect(page.locator('#pick-name')).to_have_text('晚餐')
    complete_note(page, '午饭')
    expect(page.locator('#pick-name')).to_have_text('午餐')
    assert page.locator('#note-suggest,[data-note-idx]').count() == 0
    # Another entry retains a helpful default but never invents a manual lock.
    page.locator('#keypad [data-k="8"]').click()
    page.locator('#keypad [data-k="again"]').click()
    expect(page.locator('#note')).to_have_value('')
    complete_note(page, '坐地铁')
    expect(page.locator('#pick-name')).to_have_text('地铁')
    assert not external, external
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        cases = [(width, 'Asia/Shanghai') for width in (360, 390, 430, 1280)]
        cases.append((390, 'America/Los_Angeles'))
        for width, timezone in cases:
            context = browser.new_context(
                viewport={'width': width, 'height': 844}, timezone_id=timezone,
                reduced_motion='reduce', service_workers='block',
            )
            try:
                page = context.new_page()
                page.set_default_timeout(10_000)
                run(page, width, timezone)
                print(f'PASS entry feedback {width} {timezone}', flush=True)
            except Exception:
                page.screenshot(path=str(OUT / f'failed-{width}-{timezone.replace("/", "-")}.png'), animations='disabled')
                raise
            finally:
                context.close()
        browser.close()
