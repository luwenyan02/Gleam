"""Saved main-key display and editing, with fictional credentials and no service calls."""
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/ai-key-settings'
SAVED = 'fixture-original-main-private-67890'
NEW = 'fixture-replacement-main-private-abcde'


def summary(value):
    return f'{value[:5]}••••••{value[-5:]}' if len(value) > 15 else '••••••'


def stored(page):
    return page.evaluate("sessionStorage.getItem('gleam-secret:ai.apiKey')")


def open_settings(page):
    page.locator('[data-page="page-mine"]').click()
    page.get_by_role('button', name='应用设置', exact=True).click()
    expect(page.locator('#sp-settings')).to_have_count(1)
    expect(page.locator('#sp-settings')).to_have_attribute('aria-hidden', 'false')
    expect(page.locator('#ai-key')).to_have_count(1)
    expect(page.locator('#ai-key')).to_be_attached()


def run(page, width):
    errors, external_requests = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    origin = urlsplit(URL).netloc

    def local_only(route):
        if urlsplit(route.request.url).netloc != origin:
            external_requests.append(route.request.url)
            route.abort()
        else:
            route.continue_()

    page.route('**/*', local_only)
    page.add_init_script(f"sessionStorage.setItem('gleam-secret:ai.apiKey', '{SAVED}');")
    page.goto(URL); page.locator('#fab').wait_for(); open_settings(page)
    field = page.locator('#ai-key')
    expect(field).to_have_attribute('type', 'password')
    expect(field).to_have_value('')
    expect(field).to_have_attribute('placeholder', summary(SAVED))
    assert SAVED not in page.locator('#sp-settings').inner_html()
    field.focus(); field.press('Tab')
    assert stored(page) == SAVED

    field.fill(NEW); field.press('Tab')
    expect(field).to_have_value('')
    expect(field).to_have_attribute('placeholder', summary(NEW))
    assert stored(page) == NEW
    assert NEW not in page.locator('#sp-settings').inner_html()

    # A queued save refresh can land after focus but before the next paste/input.
    # Force that empty-focused state to refresh and verify its identity and focus.
    field.focus()
    page.evaluate("""() => {
      window.__focusedKeyNode = document.querySelector('#ai-key');
      window.__focusedKeyRendered = false;
      const observer = new MutationObserver(() => {
        observer.disconnect(); window.__focusedKeyRendered = true;
      });
      observer.observe(document.querySelector('#sp-settings .sub-body'), { childList: true });
      const threshold = document.querySelector('#ai-thres');
      threshold.value = '85';
      threshold.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    page.wait_for_function('window.__focusedKeyRendered')
    assert page.evaluate("window.__focusedKeyNode === document.querySelector('#ai-key')")
    expect(field).to_be_focused()
    expect(field).to_have_value('')
    assert stored(page) == NEW

    # A copied display summary must never become a persisted credential.
    field.fill(summary(NEW)); field.press('Tab')
    expect(field).to_have_value('')
    assert stored(page) == NEW
    expect(page.locator('#toast')).to_contain_text('请输入完整的 API Key')

    # Keep the live draft node and keyboard focus while an unrelated setting refreshes.
    draft = 'fixture-still-being-edited-main-key'
    field.fill(draft)
    page.evaluate("""() => {
      window.__draftNode = document.querySelector('#ai-key');
      window.__draftRefreshes = 0;
      const root = document.querySelector('#sp-settings .sub-body');
      window.__draftObserver = new MutationObserver(() => window.__draftRefreshes++);
      window.__draftObserver.observe(root, { childList: true });
      const threshold = document.querySelector('#ai-thres');
      threshold.value = '90';
      threshold.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    page.wait_for_function('window.__draftRefreshes > 0')
    expect(field).to_have_value(draft)
    assert page.evaluate("window.__draftNode === document.querySelector('#ai-key')")
    expect(field).to_be_focused()
    assert stored(page) == NEW
    page.evaluate('window.__draftObserver.disconnect()')
    field.press('Tab')
    expect(field).to_have_value('')
    expect(field).to_have_attribute('placeholder', summary(draft))
    assert stored(page) == draft

    page.locator('#sp-settings [data-act="back"]').click()
    # The router retains an inert exit-animation node until transitionend (400 ms
    # fallback). Assert its destruction before reopening, rather than selecting
    # around duplicate IDs and accidentally reading the outgoing settings page.
    expect(page.locator('#sp-settings')).to_have_count(0)
    expect(field).to_have_count(0)
    open_settings(page)
    expect(field).to_have_value('')
    expect(field).to_have_attribute('placeholder', summary(draft))
    before_short_save = field.element_handle()
    assert before_short_save is not None
    field.fill('short-key'); field.press('Tab')
    # Saving updates the old placeholder before settings-changed queues a full
    # refresh. Wait for that saved-state render, not merely the earlier text update,
    # before checking layout or scrolling a card that the refresh will replace.
    page.wait_for_function("""({previous, expected}) => {
      const current = document.querySelector('#ai-key');
      return !previous.isConnected && current && current !== previous
        && current.value === '' && current.placeholder === expected;
    }""", arg={'previous': before_short_save, 'expected': '••••••'})
    before_short_save.dispose()
    expect(field).to_have_value('')
    expect(field).to_have_attribute('placeholder', '••••••')
    assert stored(page) == 'short-key'
    block = page.locator('#sp-settings section[aria-label="AI 记账"]')
    block.scroll_into_view_if_needed()
    assert_usable(page, '#sp-settings section[aria-label="AI 记账"]')
    page.screenshot(path=str(OUT / f'main-key-{width}.png'), animations='disabled')
    assert not errors, errors
    assert not external_requests, external_requests


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1280):
            context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block', reduced_motion='reduce')
            run(context.new_page(), width)
            context.close()
            print(f'PASS main API key settings {width}', flush=True)
        browser.close()
