"""聊天气泡内图表的真实尺寸回归；全部为虚构响应，无外部服务调用。"""
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from test_chat_artifacts import setup, fence, download_png, share_png, layout
from test_chat_resume import send, delta, finish

OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/chat-chart-layout'
WEATHER = {'version': 1, 'type': 'line', 'title': '北京未来四天气温变化',
    'labels': ['10-21', '10-22', '10-23', '10-24'], 'unit': '°C',
    'series': [{'name': '最高温', 'values': [16, 17, 17, 18]},
               {'name': '最低温', 'values': [2, 5, 7, 9]}]}


def run(browser, width, height, theme, scale):
    context, page, external, errors = setup(browser, width, height, theme, scale)
    label = f'{width}-{theme}-{scale}'
    try:
        send(page, '根据上面的数据，帮我画一张气温折线图。', 1)
        delta(page, fence(WEATHER)); finish(page)
        expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
        card = page.locator('[data-chat-chart]')
        expect(card).to_have_count(1)
        card.evaluate('''e=>{const p=document.querySelector('#life-chat-messages');
          p.scrollTo({top:p.scrollTop+e.getBoundingClientRect().top-p.getBoundingClientRect().top-12,behavior:'instant'})}''')
        page.evaluate('document.fonts.ready')
        page.screenshot(path=str(OUT / f'weather-{label}.png'), animations='disabled')
        plot = card.locator('.chat-chart-plot')
        fit = plot.evaluate('''e=>{const r=e.getBoundingClientRect();return {
          available:e.clientWidth,content:e.scrollWidth,
          cropped:[...e.querySelectorAll('circle,text')].filter(n=>{
            const b=n.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1;
          }).map(n=>n.textContent||n.tagName)}}''')
        assert fit['content'] <= fit['available'] + 1 and not fit['cropped'], ('四天数据必须完整可见', fit)
        picker = card.locator('.chat-chart-picker')
        assert picker.evaluate('e=>e.scrollWidth<=e.clientWidth+1'), '四个日期无需横滑'
        expect(card.locator('svg text').filter(has_text='10-24')).to_be_visible()
        card.locator('[data-chart-hit="3"]').click()
        expect(card.locator('[data-chat-chart-value]')).to_have_text('10-24：最高温 18°C；最低温 9°C')
        last = card.locator('[data-chart-select="3"]')
        last.focus(); last.press('Home')
        expect(card.locator('[data-chart-select="0"]')).to_be_focused()
        if width == 390 and scale == 1:
            download_png(page, card.locator('[data-chat-chart-save]'), f'weather-{theme}.png')
            share_png(page, card.locator('[data-chat-chart-share]'))
        # 大数据仍横滑，不把24个分类硬缩成不可读的小图。
        dense = {**WEATHER, 'labels': [f'第{i+1}天' for i in range(24)],
                 'series': [{'name': '气温', 'values': list(range(24))}]}
        send(page, '再展示虚构的24天趋势。', 2)
        delta(page, fence(dense)); finish(page)
        expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
        dense_card = page.locator('[data-chat-chart]').last
        assert dense_card.locator('.chat-chart-plot').evaluate('e=>e.scrollWidth>e.clientWidth')
        dense_card.locator('[data-chart-select="0"]').focus()
        page.keyboard.press('End')
        expect(dense_card.locator('[data-chat-chart-value]')).to_contain_text('第24天：气温 23°C')
        dense_card.locator('.chat-chart-plot').evaluate('e=>e.scrollLeft=e.scrollWidth')
        dense_card.locator('[data-chart-hit="23"]').click()
        expect(dense_card.locator('[data-chart-select="23"]')).to_have_attribute('aria-pressed', 'true')
        layout(page, f'layout-{label}')
        assert not external, external
        assert not errors, errors
        print('PASS chart fits chat', label, flush=True)
    finally:
        context.close()


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    # The shared PNG/layout helpers use the existing artifact directory.
    from test_chat_artifacts import OUT as ARTIFACT_OUT
    ARTIFACT_OUT.mkdir(parents=True, exist_ok=True)
    configs = [(360,844,'light',1), (390,844,'light',1), (430,844,'light',1),
               (1280,900,'dark',1), (390,640,'dark',1.3), (360,640,'light',1.3)]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            for config in configs[:1] if os.environ.get('GLEAM_CHART_LAYOUT_RED') else configs:
                run(browser, *config)
        finally:
            browser.close()
