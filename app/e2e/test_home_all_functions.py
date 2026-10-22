"""The home All menu stays viewport-anchored after scrolling; only the menu scrolls."""
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from test_home_monthly_timeline import SEED

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/home-all-functions'


def run(browser, width, theme='light', scale=1):
    context = browser.new_context(viewport={'width': width, 'height': 844}, has_touch=True,
        service_workers='block', reduced_motion='reduce')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(URL); page.locator('#fab').wait_for()
        page.evaluate(SEED, 1); page.reload()
        expect(page.locator('#hm-days [data-entry-row]')).to_have_count(60)
        page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",scale)}', [theme, str(scale)])
        page.evaluate('document.fonts.ready')
        home = page.locator('#page-home'); opener = page.locator('#hm-quick [data-qa="all"]')
        mask = page.get_by_role('dialog', name='全部功能', exact=True)
        panel = mask.locator('.picker-panel'); items = mask.locator('.picker-list')
        def open_menu(scroll):
            home.evaluate('(e,y)=>e.scrollTop=y', scroll)
            opener.click(); expect(mask).to_be_visible(); page.wait_for_timeout(250)
            assert abs(home.evaluate('e=>e.scrollTop')-scroll) < 2
            return panel.bounding_box()
        def close_menu():
            page.keyboard.press('Escape'); expect(mask).to_have_count(0)
            expect(opener).to_be_focused()
        at_top = open_menu(0)
        close_menu()
        after_scroll = open_menu(120)
        print(f'{width}px panel top: {at_top["y"]:.1f} -> {after_scroll["y"]:.1f}', flush=True)
        page.screenshot(path=str(OUT/f'all-{width}-{theme}.png'), animations='disabled')
        assert abs(after_scroll['y']-at_top['y']) < 2, 'Home scrolling moved the All menu'
        app = page.locator('.app').bounding_box()
        assert abs(after_scroll['y']+after_scroll['height']-app['y']-app['height']) < 2
        assert abs(after_scroll['x']-app['x']) < 2 and abs(after_scroll['width']-app['width']) < 2
        # The full list remains reachable, with no background scrolling.
        items.hover(); page.mouse.wheel(0, 900); page.wait_for_timeout(150)
        expect(mask.get_by_role('option', name='备份与导入', exact=True)).to_be_in_viewport()
        assert abs(home.evaluate('e=>e.scrollTop')-120) < 2
        if width == 390:
            page.set_viewport_size({'width': width, 'height': 620}); page.wait_for_timeout(250)
            box = panel.bounding_box(); app = page.locator('.app').bounding_box()
            assert abs(box['y']+box['height']-app['y']-app['height']) < 2
            page.screenshot(path=str(OUT/'all-short-screen.png'), animations='disabled')
            page.set_viewport_size({'width': width, 'height': 844}); page.wait_for_timeout(150)
        # Backdrop cancellation preserves both position and the trigger focus.
        app = page.locator('.app').bounding_box()
        page.mouse.click(app['x']+app['width']/2, app['y']+20)
        expect(mask).to_have_count(0); expect(opener).to_be_focused()
        assert abs(home.evaluate('e=>e.scrollTop')-120) < 2
        open_menu(120); page.go_back(); expect(mask).to_have_count(0)
        expect(opener).to_be_focused()
        assert abs(home.evaluate('e=>e.scrollTop')-120) < 2
        # A real menu selection still navigates, and returning restores home.
        open_menu(120); mask.get_by_role('option', name='预算', exact=True).click()
        expect(page.locator('#sp-budget.open')).to_be_visible(); expect(mask).to_have_count(0)
        page.locator('#sp-budget [data-act="back"]').click()
        expect(page.locator('#sp-budget')).to_have_count(0)
        assert abs(home.evaluate('e=>e.scrollTop')-120) < 2
        assert not errors, errors
        print(f'PASS All menu anchoring, scrolling, dismiss and navigation {width}px {theme}', flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for profile in [(360,'light',1),(390,'light',1),(430,'dark',1.3),(1280,'light',1)]:
            run(browser, *profile)
        browser.close()
