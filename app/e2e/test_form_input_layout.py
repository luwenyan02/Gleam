"""Merchant and related input layout, using isolated fictional records and no AI calls."""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

from test_browser_usability import assert_usable
from test_import_safety import seed

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/form-input-layout'
CARD = '#sp-ai-inbox [data-temp="fiction-form-layout"]'

# fill() changes value on the old input. refresh() must replace its markup before
# defaultValue also matches, so a persisted edit alone cannot satisfy this wait.
MERCHANT_RENDERED = '''({selector, value}) => {
  const card = document.querySelector(selector);
  const input = card?.querySelector('[data-field=merchant]');
  return Boolean(card?.isConnected && input && input.value === value && input.defaultValue === value);
}'''

# Query and measure synchronously in the page. A locator handle resolved before
# the callback starts may already belong to the detached pre-refresh card.
CARD_GEOMETRY = '''selector => {
  const card = document.querySelector(selector);
  if (!card?.isConnected) throw new Error('Card is not connected');
  const box = el => el.getBoundingClientRect().toJSON();
  const merchant = card.querySelector('[data-field=merchant]');
  const fields = card.querySelector('.ai-fields');
  const names = ['merchant', 'amount', 'time', 'category', 'account', 'note'];
  return {
    card: box(card), merchant: box(merchant), fields: box(fields),
    controls: names.map(name => {
      const el = card.querySelector(`[data-field=${name}]`);
      const style = getComputedStyle(el);
      return {name, ...box(el), border: style.borderTopWidth,
        radius: parseFloat(style.borderTopLeftRadius), shadow: style.boxShadow};
    }),
  };
}'''


def wait_for_merchant(page, value):
    page.wait_for_function('''async value => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('settings', 'readonly');
      const record = await new Promise((resolve, reject) => {
        const request = tx.objectStore('settings').get('ai.pendingItems');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return (record?.value?.[0]?.merchantName ?? '') === value;
    }''', arg=value)
    page.wait_for_function(MERCHANT_RENDERED, arg={'selector': CARD, 'value': value})


def assert_card_layout(page):
    assert_usable(page, CARD)
    geometry = page.evaluate(CARD_GEOMETRY, CARD)
    controls = {item['name']: item for item in geometry['controls']}
    for control in controls.values():
        assert control['width'] >= 44 and control['height'] >= 44, control
        assert control['border'] == '1px' and control['radius'] > 0, control
        assert control['shadow'] == 'none', control
        assert control['left'] >= geometry['fields']['left'] - 1, control
        assert control['right'] <= geometry['fields']['right'] + 1, control
    assert abs(controls['merchant']['right'] - geometry['fields']['right']) < 1
    for first, second in [('amount', 'time'), ('category', 'account')]:
        assert abs(controls[first]['width'] - controls[second]['width']) < 1
        assert abs(controls[first]['height'] - controls[second]['height']) < 1
        assert abs(controls[first]['top'] - controls[second]['top']) < 1


def run(page, width, theme):
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://**/*', lambda route: (external.append(route.request.url), route.abort()))
    page.goto(URL)
    page.locator('#fab').wait_for()
    seed(page)
    page.evaluate('''async theme => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({key: 'theme.mode', value: theme, updatedAt: Date.now()});
      tx.objectStore('settings').put({key: 'ai.pendingItems', updatedAt: Date.now(), value: [{
        tempId: 'fiction-form-layout', status: 'ready', source: 'voice', type: 'expense',
        merchantName: '虚构午餐商家', amount: 2800,
        categoryName: '虚构超长餐饮分类/虚构超长午餐名称',
        accountName: '虚构超长账户名称用于检查窄屏布局',
        note: '', rawText: '虚构午餐二十八元，现金支付。',
        occurredAt: 1788339600000, confidence: 95, createdAt: Date.now(),
      }]});
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
    }''', theme)
    page.reload()
    page.locator('#fab').wait_for()
    page.wait_for_function("theme => (document.documentElement.dataset.theme ?? 'light') === theme", arg=theme)
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-ai-inbox"]').click()
    merchant = page.locator(f'{CARD} [data-field="merchant"]')
    merchant.wait_for()
    page.wait_for_timeout(300)
    assert_card_layout(page)

    # Empty and long drafts must not change the grid width or lose the merchant value.
    for name in ['', '虚构长商家名称' * 12, '虚构修改商家']:
        merchant.fill(name)
        merchant.blur()
        wait_for_merchant(page, name)
        expect(merchant).to_have_value(name)
        assert_card_layout(page)
    merchant.focus()
    assert_card_layout(page)
    merchant.blur()
    assert page.evaluate("document.documentElement.dataset.theme ?? 'light'") == theme
    page.screenshot(path=str(OUT / f'inbox-{width}-{theme}.png'), animations='disabled')
    # Keep the top image and also expose the note/actions below the viewport.
    # Scrolling never changes focus; restore the offset before the picker flow.
    scroller = page.locator('#sp-ai-inbox .sub-body')
    scroll_top = scroller.evaluate('el => el.scrollTop')
    try:
        page.locator(f'{CARD} .ai-actions').scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / f'inbox-details-{width}-{theme}.png'), animations='disabled')
    finally:
        scroller.evaluate('(el, top) => { el.scrollTop = top; }', scroll_top)

    # The same shared picker search input is at least 44 px; dismiss keeps the draft.
    page.locator(f'{CARD} [data-field="category"]').click()
    page.locator('.picker-search input').wait_for()
    page.wait_for_timeout(250)
    assert_usable(page, '.picker-panel')
    page.keyboard.press('Escape')
    page.locator('.picker-panel').wait_for(state='detached')
    expect(merchant).to_have_value('虚构修改商家')
    page.locator('#sp-ai-inbox [data-act="back"]').click()
    page.locator('#sp-ai-inbox').wait_for(state='detached')
    page.locator('#page-mine [data-sub="sp-ai-inbox"]').click()
    expect(merchant).to_have_value('虚构修改商家')
    assert_card_layout(page)
    page.locator('#sp-ai-inbox [data-act="back"]').click()
    page.locator('#sp-ai-inbox').wait_for(state='detached')

    # Merchant management uses the same labeled .note fields as categories/templates.
    page.locator('#page-mine [data-sub="sp-tags"]').click()
    page.locator('#tm-addshop').click()
    management = page.locator('#tm-name')
    management.wait_for()
    management.fill('虚构商家')
    page.wait_for_timeout(300)
    assert_usable(page, '#sheet')
    aligned = management.evaluate('''input => {
      const label = input.previousElementSibling.getBoundingClientRect();
      const box = input.getBoundingClientRect();
      return { margin: getComputedStyle(input).marginBottom,
        centerDifference: Math.abs((label.top + label.bottom - box.top - box.bottom) / 2) };
    }''')
    assert aligned['margin'] == '0px' and aligned['centerDifference'] < 1, aligned
    page.locator('#sheet [data-act="close"]').click()
    page.locator('#sheet.open').wait_for(state='detached')
    page.locator('#sp-tags [data-act="back"]').click()
    page.locator('#sp-tags').wait_for(state='detached')

    # Entry's new-merchant row must fit alongside its Create button on narrow screens.
    page.locator('.tab[data-page="page-home"]').click()
    page.locator('#fab').click()
    page.locator('#sheet [data-act="toggle-advanced"]').click()
    page.locator('#chip-shop').click()
    page.locator('.picker-item[data-value="__new__"]').click()
    create = page.locator('.picker-new input')
    create.wait_for()
    create.fill('虚构长商家草稿' * 10)
    page.wait_for_timeout(300)
    assert_usable(page, '.picker-new')
    assert create.evaluate('''input => {
      const button = input.nextElementSibling.getBoundingClientRect();
      const box = input.getBoundingClientRect();
      return box.right <= button.left && Math.abs(box.height - button.height) < 1;
    }''')
    page.screenshot(path=str(OUT / f'create-merchant-{width}-{theme}.png'), animations='disabled')
    assert not errors, errors
    assert not external, external


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for width in (360, 390, 430, 1280):
                for theme in ('light', 'dark'):
                    context = browser.new_context(viewport={'width': width, 'height': 900}, service_workers='block')
                    page = None
                    try:
                        page = context.new_page()
                        page.set_default_timeout(10_000)
                        run(page, width, theme)
                        print(f'PASS form input layout {width} {theme}', flush=True)
                    except Exception:
                        try:
                            if page is not None:
                                page.screenshot(path=str(OUT / f'failed-{width}-{theme}.png'), animations='disabled')
                        except Exception as screenshot_error:
                            print(f'Could not capture failure screenshot: {screenshot_error}', flush=True)
                        raise
                    finally:
                        context.close()
        finally:
            browser.close()
