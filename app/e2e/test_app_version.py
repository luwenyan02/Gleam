"""Truthful package/interface version labels with a synthetic bridge; no service calls."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from test_browser_usability import assert_usable
from test_short_voice import MOCK_NATIVE

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/app-version'
WEB_VERSION = json.loads((Path(__file__).parents[1] / 'package.json').read_text())['version']
CASES = ('web', 'native-match', 'native-mismatch', 'native-unavailable')


def run(page, width, case):
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    origin = urlsplit(URL).netloc

    def local_only(route):
        if urlsplit(route.request.url).netloc != origin:
            external.append(route.request.url); route.abort()
        else:
            route.continue_()

    page.route('**/*', local_only)
    native = case != 'web'
    version = '91.2.3' if case == 'native-mismatch' else WEB_VERSION
    unavailable = case == 'native-unavailable'
    if native:
        page.add_init_script(MOCK_NATIVE + f'; window.__appVersion = {json.dumps(version)}; window.__appInfoFailure = {json.dumps(unavailable)};')
    page.goto(URL); page.locator('#fab').wait_for()
    page.locator('[data-page="page-mine"]').click()
    about = page.locator('#page-mine [data-about]')
    label = '未读取' if unavailable else f'v{version}'
    platform = 'Android' if native else 'PWA'
    expect(about.locator('[data-app-version]')).to_have_text(f'{label} · {platform}')
    if native:
        expect(about).not_to_contain_text('PWA')
    about.scroll_into_view_if_needed()
    assert_usable(page, '#page-mine [data-about]')
    page.screenshot(path=str(OUT / f'mine-{case}-{width}.png'), animations='disabled')
    about.click()
    toast = page.locator('#sheet .about-version') if native else page.locator('#toast')
    expect(toast).to_contain_text('应用版本未读取' if unavailable else f'拾光 v{version}')
    expect(toast).to_contain_text(platform)
    mismatch = case in ('native-mismatch', 'native-unavailable')
    if mismatch:
        expect(toast).to_contain_text(f'界面 v{WEB_VERSION}')
    else:
        expect(toast).not_to_contain_text('界面')
    expect(toast).not_to_contain_text('synthetic package info unavailable')
    if native:
        page.get_by_role('button', name='关闭关于拾光', exact=True).click()

    page.get_by_role('button', name='应用设置', exact=True).click()
    settings = page.locator('#sp-settings')
    expect(settings).to_have_count(1)
    expect(settings.locator('[data-app-version]')).to_have_text(label)
    if mismatch:
        expect(settings.locator('[data-interface-version]')).to_have_text(f'v{WEB_VERSION}')
    else:
        expect(settings.locator('[data-interface-version]')).to_have_count(0)
    section = settings.locator('section[aria-label="关于"]')
    section.scroll_into_view_if_needed()
    assert_usable(page, '#sp-settings section[aria-label="关于"]')
    page.screenshot(path=str(OUT / f'settings-{case}-{width}.png'), animations='disabled')
    if native:
        reads = page.evaluate('window.__appInfoCalls')
        assert reads >= 2 if unavailable else reads == 1, reads
        assert page.evaluate('window.__micCalls') == 0
    assert not external, external
    assert not errors, errors


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 430, 1280):
            for case in CASES:
                context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block', reduced_motion='reduce')
                run(context.new_page(), width, case)
                context.close()
            print(f'PASS app/package version labels {width}', flush=True)
        browser.close()
