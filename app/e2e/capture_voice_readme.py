"""Capture current voice UI with fictional data and a synthetic native bridge.

No microphone, audio or external service is used. Raw PNGs stay in .tmp until
visually reviewed; this script never overwrites published documentation images.
"""

from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from capture_readme import DEMO_TIME, URL, seed
from test_browser_usability import assert_usable
from test_hold_voice import hold, preview, release_at
from test_native_live_voice import MOCK, assert_inline
from test_short_voice import seed_config


OUTPUT = Path(__file__).parents[2] / '.tmp/tests/e2e/readme-voice'


def run(browser, width):
    context = browser.new_context(viewport={'width': width, 'height': 844},
        timezone_id='Asia/Shanghai', locale='zh-CN', color_scheme='light',
        service_workers='block', reduced_motion='no-preference')
    page = context.new_page()
    errors, blocked = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    origin = urlsplit(URL)

    def route_request(route):
        target = urlsplit(route.request.url)
        if (target.scheme, target.netloc) == (origin.scheme, origin.netloc):
            route.continue_()
        else:
            blocked.append(route.request.url)
            route.abort()

    page.route('**/*', route_request)
    page.add_init_script(MOCK + ';window.__voiceHasKey=true;')
    page.clock.set_fixed_time(DEMO_TIME)
    output = OUTPUT / str(width)
    output.mkdir(parents=True, exist_ok=True)

    def capture(name, selector):
        page.locator('#toast.show').wait_for(state='hidden')
        page.evaluate('document.activeElement?.blur()')
        page.wait_for_timeout(450)
        assert_usable(page, selector)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        # Finish entrance transitions; retain a real frame of the looping waves.
        assert page.locator(selector).evaluate('''el => el.getAnimations({subtree:true})
            .every(a => a.effect.getTiming().iterations === Infinity || a.playState === 'finished')''')
        page.screenshot(path=str(output / f'{name}-demo.png'))

    try:
        page.goto(URL)
        page.locator('#fab').wait_for()
        seed(page)
        seed_config(page)
        page.evaluate("window.__voiceText='午饭32元，用日常钱包'")
        hold(page)
        expect(page.locator('.hold-voice-wave')).to_be_visible()
        capture('voice-recording', '.hold-voice-stage')
        preview(page, '午饭32元，用日常钱包')
        release_at(page, 'edit')
        expect(page.locator('[data-hv-text]')).to_have_value('午饭32元，用日常钱包')
        capture('voice-editing', '.hold-voice-stage')
        page.locator('[data-hv-close]').click()
        page.locator('.hold-voice-mask').wait_for(state='hidden')

        page.locator('[data-page="page-life"]').click()
        page.locator('[data-life-chat]').click()
        page.wait_for_function("""() => {
            const el=document.querySelector('#sp-life-chat');
            return el?.classList.contains('open') && getComputedStyle(el).transform === 'none';
        }""")
        baseline = page.locator('#life-chat-messages').bounding_box()
        page.locator('[data-chat-voice]').click()
        page.locator('[data-voice-start]').click()
        expect(page.locator('[data-voice-mute]')).to_be_visible()
        messages = [
            {'role': 'user', 'content': '今天下班想走走，不想把晚上安排得太满。'},
            {'role': 'assistant', 'content': '那就沿河走一小段吧。看见喜欢的店就进去坐坐，累了再回家。'},
            {'role': 'user', 'content': '好呀，顺便买杯热茶。帮我记住这个小计划。'},
        ]
        page.evaluate("messages => window.__liveEvent({state:'listening',messages})", messages)
        expect(page.locator('.chat-voice-overlay')).to_have_attribute('data-voice-state', 'listening')
        assert_inline(page)
        current = page.locator('#life-chat-messages').bounding_box()
        assert abs(current['height'] - baseline['height']) <= 1, (baseline, current)
        capture('voice-listening', '#sp-life-chat')
        messages.append({'role': 'assistant', 'content': '今晚的小计划：散步、热茶，慢慢回家。聊完点一下「整理」，就能把它存进生活记录。'})
        page.evaluate("messages => window.__liveEvent({state:'speaking',messages})", messages)
        expect(page.locator('[data-voice-status]')).to_contain_text('拾光在说话')
        assert_inline(page)
        capture('voice-speaking', '#sp-life-chat')
        assert page.evaluate('window.__micCalls') == 0
        assert not errors, errors
        assert not blocked, 'Unexpected external requests were blocked'
        print(f'Voice showcase {width}px: four raw screenshots; layout and isolation passed')
    finally:
        context.close()


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for width in (360, 390, 430, 1280):
                run(browser, width)
        finally:
            browser.close()
