"""自定义趋势日期标签不重叠，保留全部柱形及明细区间；只使用虚构账目。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from test_report_composition import seed

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/report-trend-labels'


def choose_date(page, date):
    panel = page.locator('.dw-panel[aria-modal="true"]:not([inert])')
    panel.wait_for()
    for label, value, base in zip(('年', '月', '日'), date, (2000, 1, 1)):
        col = panel.get_by_role('spinbutton', name=label, exact=True)
        col.press('Home')
        for _ in range(value - base):
            col.press('ArrowDown')
    panel.locator('.dw-confirm').click()


def check_labels(page):
    result = page.locator('#trend svg').evaluate('''svg => {
      const bounds = svg.getBoundingClientRect();
      const labels = [...svg.querySelectorAll('text')].filter(e => getComputedStyle(e).visibility !== 'hidden');
      return {bounds: {left: bounds.left, right: bounds.right, bottom: bounds.bottom},
        labels: labels.map(e => {const r=e.getBoundingClientRect();return {text:e.textContent,left:r.left,right:r.right,bottom:r.bottom}})};
    }''')
    labels, bounds = result['labels'], result['bounds']
    assert labels, result
    for label in labels:
        assert label['left'] >= bounds['left'] - 1 and label['right'] <= bounds['right'] + 1, result
        assert label['bottom'] <= bounds['bottom'] + 1, result
    for left, right in zip(labels, labels[1:]):
        assert left['right'] + 2 <= right['left'], result
    assert page.locator('#trend svg text').first.is_visible()
    assert page.locator('#trend svg text').last.is_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width, theme, scale in [(360, 'light', 1), (390, 'light', 1), (430, 'dark', 1.3), (1280, 'light', 1)]:
            ctx = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block', reduced_motion='reduce', timezone_id='Asia/Shanghai')
            ctx.add_init_script(f"document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('--seed-type', '{scale}'))")
            page = ctx.new_page()
            page.clock.set_fixed_time('2026-10-22T12:00:00+08:00')
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(URL) else route.abort())
            page.goto(URL)
            page.locator('#fab').wait_for()
            seed(page, 'mixed', theme)
            page.locator('.tab[data-page="page-report"]').click()
            for name, start, end in [
                ('ten-months', (2026, 1, 1), (2026, 10, 31)),
                ('cross-year', (2025, 11, 1), (2026, 10, 31)),
                ('month', (2026, 10, 1), (2026, 10, 31)),
                ('single-day', (2026, 10, 1), (2026, 10, 1)),
            ]:
                if name == 'ten-months':
                    page.locator('#r-seg [data-p="custom"]').click()
                else:
                    page.locator('#r-label').click()
                choose_date(page, start)
                choose_date(page, end)
                page.wait_for_function('(label) => document.querySelector("#r-label").textContent === label', arg=f'{start[0]}/{start[1]}/{start[2]} – {end[0]}/{end[1]}/{end[2]}')
                page.locator('#trend svg').wait_for()
                page.locator('#report-trend-card').scroll_into_view_if_needed()
                page.wait_for_timeout(300)
                page.screenshot(path=str(OUT / f'{name}-{width}.png'), animations='disabled')
                check_labels(page)
                if name == 'ten-months':
                    page.locator('#report-dim [data-dimension="category"]').click()
                    page.locator('#report-rank-card:not([hidden])').wait_for()
                    page.locator('#report-dim [data-dimension="trend"]').click()
                    page.locator('#report-trend-card:not([hidden])').wait_for()
                    check_labels(page)
                ranges = page.locator('.trend-hit').evaluate_all('els => els.map(e => [Number(e.dataset.drillFrom), Number(e.dataset.drillTo)])')
                expected = page.evaluate('([a,b]) => [new Date(a[0],a[1]-1,a[2]).getTime(),new Date(b[0],b[1]-1,b[2]+1).getTime()]', [start, end])
                assert ranges[0][0] == expected[0] and ranges[-1][1] == expected[1]
                assert all(a[1] == b[0] for a, b in zip(ranges, ranges[1:]))
                assert len(ranges) == (1 if name == 'single-day' else (8 if name == 'month' else 10))
                # 即使未显示横轴文字，该柱仍可键盘进入准确日期明细。
                index = min(1, len(ranges) - 1)
                hit = page.locator('.trend-hit').nth(index)
                hit.focus()
                hit.press('Enter')
                page.locator('#sr-date-from').wait_for()
                expected_labels = page.evaluate('r => r.map((v,i) => {const d=new Date(v-(i?1:0));return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`})', ranges[index])
                assert expected_labels[0] in page.locator('#sr-date-from').inner_text()
                assert expected_labels[1] in page.locator('#sr-date-to').inner_text()
                page.go_back()
                page.locator('#trend svg').wait_for()
            for period in ('week', 'month', 'year'):
                page.locator(f'#r-seg [data-p="{period}"]').click()
                page.wait_for_timeout(300)
                if page.locator('#trend svg').count():
                    check_labels(page)
                    if period == 'year':
                        assert all(tick.is_visible() for tick in page.locator('#trend svg text').all())
                        page.screenshot(path=str(OUT / f'year-{width}.png'), animations='disabled')
            assert not errors, errors
            print(f'PASS trend labels, full bucket coverage and drilldown: {width} {theme} scale={scale}', flush=True)
            ctx.close()
        browser.close()


if __name__ == '__main__':
    main()
