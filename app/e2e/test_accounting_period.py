"""财务月起始日：设置、首页、月报表与月预算的定向多宽度验收。"""
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(os.environ.get(
    'GLEAM_E2E_SCREENSHOTS',
    Path(__file__).parents[2] / '.tmp/tests/e2e/screenshots',
)) / 'accounting-period'


def seed_current_expense(page) -> None:
    page.evaluate("""async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const now = Date.now();
      const tx = db.transaction(['categories', 'entries'], 'readwrite');
      tx.objectStore('categories').put({
        id: 900001, name: '虚构财务月分类', icon: 'ic-bowl', kind: 'expense',
        sortOrder: 900001, createdAt: now, updatedAt: now,
      });
      tx.objectStore('entries').put({
        id: 900001, type: 'expense', amount: 12345, occurredAt: now,
        categoryId: 900001, accountId: 1, reimburseStatus: 'none',
        deletedAt: 0, createdAt: now, updatedAt: now,
      });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    }""")


def expected_period(page) -> dict:
    return page.evaluate("""() => {
      const now = new Date();
      const startDay = 28;
      const keyStart = new Date(now.getFullYear(), now.getMonth() + (now.getDate() < startDay ? -1 : 0), startDay);
      const end = new Date(keyStart.getFullYear(), keyStart.getMonth() + 1, startDay);
      const last = new Date(end);
      last.setDate(last.getDate() - 1);
      const key = `${keyStart.getFullYear()}-${String(keyStart.getMonth() + 1).padStart(2, '0')}`;
      return {
        key,
        monthLabel: `${keyStart.getMonth() + 1}月`,
        longRange: `${keyStart.getFullYear()}/${keyStart.getMonth() + 1}/${keyStart.getDate()} – ${last.getFullYear()}/${last.getMonth() + 1}/${last.getDate()}`,
        homeRange: `${keyStart.getMonth() + 1}月${keyStart.getDate()}日–${last.getMonth() + 1}月${last.getDate()}日`,
        naturalYear: now.getFullYear(),
      };
    }""")


def assert_layout(page, selector: str) -> None:
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), '页面出现横向溢出'
    assert page.locator(selector).evaluate('el => el.scrollWidth <= el.clientWidth + 1'), f'{selector} 内容横向溢出'
    clipped = page.locator(f'{selector} button, {selector} select').evaluate_all("""els => els
      .filter(el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && (r.width < 43 || r.height < 43);
      }).map(el => ({ text: el.textContent.trim(), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }))""")
    assert not clipped, f'触控目标小于 44px: {clipped}'


def run_width(page, width: int) -> None:
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL)
    page.wait_for_selector('#hm-month:not([hidden])')
    seed_current_expense(page)

    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-settings"]').first.click()
    page.wait_for_selector('#sp-settings.open #accounting-month-start')
    page.locator('#accounting-month-start').click()
    page.wait_for_selector('#sp-settings .picker-panel.open')
    page.locator('#sp-settings .picker-panel').screenshot(
        path=str(OUT / f'settings-picker-{width}.png'), animations='disabled')
    page.locator('#sp-settings .picker-item[data-value="28"]').click()
    expected = expected_period(page)
    # Wait for the asynchronous settings save and re-render, not the existing period label.
    expect(page.locator('#accounting-month-start')).to_have_text('每月 28 日')
    expect(page.locator('#sp-settings section[aria-label="记账偏好"]')).to_contain_text(expected['longRange'])
    settings_text = page.inner_text('#sp-settings section[aria-label="记账偏好"]')
    period_row = page.locator('#sp-settings section[aria-label="记账偏好"] .field').filter(has_text='本期范围')
    expect(period_row.locator('.sub')).to_have_text(expected['longRange'])
    assert '财务月' not in settings_text, settings_text
    assert page.locator('#accounting-month-start').inner_text() == '每月 28 日'
    assert page.locator('#sp-settings select').count() == 0
    assert_layout(page, '#sp-settings')
    page.locator('#sp-settings section[aria-label="记账偏好"]').screenshot(
        path=str(OUT / f'settings-{width}.png'), animations='disabled')
    page.locator('#sp-settings .sub-head [data-act="back"]').click()
    page.wait_for_selector('#sp-settings', state='detached')

    page.locator('.tab[data-page="page-home"]').click()
    page.wait_for_function(f"document.querySelector('#hm-month .mc-label')?.textContent.includes('{expected['homeRange']}')")
    home_label = page.inner_text('#hm-month .mc-label')
    assert expected['homeRange'] in home_label, home_label
    assert '财务月' not in home_label, home_label
    assert page.inner_text('#m-spend') == '123.45'
    assert_layout(page, '#page-home')
    page.locator('#hm-month').screenshot(path=str(OUT / f'home-{width}.png'), animations='disabled')

    page.locator('.tab[data-page="page-report"]').click()
    page.wait_for_function(f"document.querySelector('#r-label')?.textContent.includes('{expected['longRange']}')")
    report_label = page.inner_text('#r-label')
    assert report_label == f"{expected['monthLabel']} · {expected['longRange']}", report_label
    assert expected['key'] not in report_label, report_label
    assert '财务月' not in report_label, report_label
    assert page.inner_text('#r-spend') == '¥123.45'
    ranges = page.locator('#trend [data-drill-from][data-drill-to]').evaluate_all(
        "els => els.map(el => [Number(el.dataset.drillFrom), Number(el.dataset.drillTo)])")
    assert ranges and all(ranges[index][1] == ranges[index + 1][0] for index in range(len(ranges) - 1)), ranges
    assert_layout(page, '#page-report')
    page.locator('#page-report').screenshot(path=str(OUT / f'report-{width}.png'), animations='disabled')

    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-budget"]').click()
    page.wait_for_selector('#sp-budget.open')
    page.wait_for_function(f"document.querySelector('#sp-budget')?.textContent.includes('{expected['longRange']}')")
    budget_text = page.inner_text('#sp-budget')
    assert expected['key'] in budget_text and expected['longRange'] in budget_text, budget_text
    assert '财务月' not in budget_text, budget_text
    page.locator('#sp-budget [data-act="mode"]').click()
    page.wait_for_function("document.querySelector('#sp-budget')?.textContent.includes('年总预算')")
    assert f"{expected['naturalYear']}年总预算" in page.inner_text('#sp-budget')
    page.locator('#sp-budget [data-act="mode"]').click()
    page.wait_for_function(f"document.querySelector('#sp-budget')?.textContent.includes('{expected['longRange']}')")
    assert '财务月' not in page.inner_text('#sp-budget')
    assert_layout(page, '#sp-budget')
    page.locator('#sp-budget').screenshot(path=str(OUT / f'budget-{width}.png'), animations='disabled')

    # 摘要必须与预算中心同一期，不能回退为自然月。
    page.click('#sp-budget [data-bd-set]')
    page.fill('#bd-total', '1000')
    page.click('#sheet [data-act="save"]')
    expect(page.locator('#sp-budget .bd-meta')).to_contain_text('¥876.55')
    page.click('#sp-budget .sub-head [data-act="back"]')
    page.wait_for_selector('#sp-budget', state='detached')
    expect(page.locator('#page-mine [data-sub="sp-budget"] .row-note')).to_have_text('本期剩余 ¥876.55')

    assert not errors, errors


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for width in (360, 390, 430, 1024):
            context = browser.new_context(viewport={'width': width, 'height': 844}, service_workers='block')
            page = context.new_page()
            run_width(page, width)
            print(f'PASS accounting period {width}', flush=True)
            context.close()
        browser.close()


if __name__ == '__main__':
    main()
