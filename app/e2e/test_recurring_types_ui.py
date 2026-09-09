"""周期账收支类型与表单宽度的局部浏览器验收；仅使用自动种子虚构数据。"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


URL = os.environ.get("GLEAM_E2E_URL", "http://127.0.0.1:4601/")
SHOTS = Path(os.environ.get(
    "GLEAM_E2E_SCREENSHOTS",
    Path(__file__).parents[2] / ".tmp/tests/e2e/screenshots",
))
SHOTS.mkdir(parents=True, exist_ok=True)


def category_names(page, kind: str) -> list[str]:
    return page.evaluate(
        """async kind => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const tx = db.transaction('categories');
          const rows = await new Promise((resolve, reject) => {
            const request = tx.objectStore('categories').getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          db.close();
          return rows.filter(row => row.kind === kind).map(row => row.name);
        }""",
        kind,
    )


def recurring_rule(page, name: str) -> dict:
    return page.evaluate(
        """async name => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const tx = db.transaction('recurringRules');
          const rows = await new Promise((resolve, reject) => {
            const request = tx.objectStore('recurringRules').getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          db.close();
          return rows.find(row => row.name === name);
        }""",
        name,
    )


def assert_equal_widths(page) -> None:
    widths = page.locator("#rc-name, #rc-amount, #rc-dom, #rc-cat, #rc-acct").evaluate_all(
        "elements => elements.map(element => Math.round(element.getBoundingClientRect().width))"
    )
    assert len(widths) == 5, widths
    assert max(widths) - min(widths) <= 1, widths


def collect_schedule_layout_issues(page, width: int) -> list[str]:
    issues: list[str] = []

    def check_help(text: str) -> None:
        geometry = page.get_by_text(text, exact=True).evaluate(
            """element => {
              const control = document.querySelector('#rc-name');
              const help = element.getBoundingClientRect();
              const input = control.getBoundingClientRect();
              return {
                textAlign: getComputedStyle(element).textAlign,
                rightGap: Math.abs(help.right - input.right),
              };
            }"""
        )
        if geometry["textAlign"] != "right" or geometry["rightGap"] > 1:
            issues.append(f"说明未与输入框右端对齐: {text} {geometry}")

    check_help("开启后，到期核对金额再入账")
    page.wait_for_timeout(350)

    def downstream_positions():
        return page.locator('#rc-cat, #rc-acct, #sheet [data-act="save"]').evaluate_all(
            'elements => elements.map(e => Math.round(e.getBoundingClientRect().top))'
        )

    baseline = downstream_positions()
    assert page.locator('#rc-days').evaluate('e=>e.getBoundingClientRect().height<=64'),'入账日区域不应预留说明空白'
    assert page.locator('#rc-days .rc-help').count()==0

    page.locator('#rc-freq [data-freq="weekly"]').click()
    if downstream_positions() != baseline:
        issues.append('切换每周时下方控件位置发生变化')
    same_row = page.locator('.rc-weekly-field').evaluate('''element => {
      const label=element.querySelector(':scope > span').getBoundingClientRect();
      const button=element.querySelector('[data-dow]').getBoundingClientRect();
      return Math.abs((label.top+label.bottom)/2-(button.top+button.bottom)/2)<2;
    }''')
    if not same_row:
        issues.append('入账日标签与星期按钮不在同一行')
    boxes = page.locator("#rc-dow [data-dow]").evaluate_all(
        """elements => elements.map(element => {
          const box = element.getBoundingClientRect();
          return { top: Math.round(box.top), width: box.width, height: box.height };
        })"""
    )
    if len(boxes) != 7:
        issues.append(f"每周按钮数量不是7: {len(boxes)}")
    elif len({box["top"] for box in boxes}) != 1:
        issues.append(f"每周按钮未保持一行: {boxes}")
    if any(box["width"] < 44 or box["height"] < 44 for box in boxes):
        issues.append(f"每周按钮触控区小于44px: {boxes}")
    assert page.locator('#rc-dow').evaluate('''rail=>{
      rail.scrollLeft=rail.scrollWidth;
      const edge=rail.getBoundingClientRect(),last=rail.lastElementChild.getBoundingClientRect();
      const reachable=last.left>=edge.left-1&&last.right<=edge.right+1;
      rail.scrollLeft=0;return reachable;
    }'''),'窄屏必须能滑到最后一个星期按钮'
    assert "active" in page.locator('#rc-freq [data-freq="weekly"]').get_attribute("class")
    page.screenshot(
        path=str(SHOTS / f"recurring-weekly-{width}.png"),
        full_page=True,
        animations="disabled",
    )

    page.locator('#rc-freq [data-freq="monthly"]').click()
    if downstream_positions() != baseline:
        issues.append('切换每月时下方控件位置发生变化')
    assert page.locator('#rc-dom').get_attribute('placeholder')=='日期，如 5,20'
    page.screenshot(path=str(SHOTS / f'recurring-monthly-{width}.png'),animations='disabled')

    page.locator('#rc-freq [data-freq="yearly"]').click()
    if downstream_positions() != baseline:
        issues.append('切换每年时下方控件位置发生变化')
    assert page.locator('#rc-mmdd').get_attribute('placeholder')=='月日，如 0101,0615'
    assert page.locator('#rc-days .rc-help').count()==0
    yearly_widths = page.locator("#rc-name, #rc-mmdd").evaluate_all(
        "elements => elements.map(element => Math.round(element.getBoundingClientRect().width))"
    )
    if max(yearly_widths) - min(yearly_widths) > 1:
        issues.append(f"每年输入框宽度不一致: {yearly_widths}")
    assert "active" in page.locator('#rc-freq [data-freq="yearly"]').get_attribute("class")
    page.screenshot(
        path=str(SHOTS / f"recurring-yearly-{width}.png"),
        full_page=True,
        animations="disabled",
    )

    page.locator('#rc-freq [data-freq="monthly"]').click()
    page.locator('#rc-freq [data-freq="daily"]').click()
    if downstream_positions() != baseline:
        issues.append('切换每天时下方控件位置发生变化')
    assert '每天 09:00' in page.locator('#rc-days').inner_text()
    page.screenshot(path=str(SHOTS / f'recurring-daily-{width}.png'), animations='disabled')
    page.locator('#rc-freq [data-freq="monthly"]').click()
    return issues


def check_width(page, width: int) -> None:
    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.locator("#fab").wait_for()
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-recurring"]').click()
    page.locator("[data-rc-add]").click()
    page.locator("#rc-name").wait_for()

    assert page.locator('#rc-type [data-type="expense"]').get_attribute("class").endswith("active")
    assert_equal_widths(page)
    assert page.locator("#sheet .sheet-scroll").evaluate(
        "element => element.scrollWidth <= element.clientWidth + 1"
    )
    schedule_issues = collect_schedule_layout_issues(page, width)
    assert not schedule_issues, " | ".join(schedule_issues)

    page.locator('#rc-type [data-type="income"]').click()
    income_names = category_names(page, "income")
    selected_label = page.locator("#rc-cat").inner_text()
    assert selected_label in income_names, (selected_label, income_names)
    assert page.locator("#rc-cat").get_attribute("aria-label") == "收入分类"

    page.locator("#rc-cat").click()
    picker_labels = page.locator(".picker-item-label").all_inner_texts()
    assert picker_labels == income_names, (picker_labels, income_names)
    page.locator(".picker-item").first.click()
    page.locator(".picker-mask").wait_for(state="detached")

    page.locator("#rc-name").fill("虚构月度工资")
    page.locator("#rc-amount").fill("1234.56")
    page.locator("#rc-dom").fill("5")
    page.screenshot(
        path=str(SHOTS / f"recurring-new-{width}.png"),
        full_page=True,
        animations="disabled",
    )
    page.locator('[data-act="save"]').click()
    page.get_by_text("虚构月度工资", exact=False).wait_for()

    rule = recurring_rule(page, "虚构月度工资")
    assert rule["type"] == "income", rule
    assert rule["categoryId"] is not None

    page.locator('[data-id]').filter(has_text="虚构月度工资").click()
    page.locator("#rc-name").wait_for()
    assert page.locator('#rc-type [data-type="income"]').get_attribute("class").endswith("active")
    assert page.locator("#rc-cat").get_attribute("aria-label") == "收入分类"
    assert_equal_widths(page)
    page.wait_for_function("getComputedStyle(document.querySelector('#toast')).opacity === '0'")
    page.screenshot(
        path=str(SHOTS / f"recurring-edit-{width}.png"),
        full_page=True,
        animations="disabled",
    )


if __name__ == "__main__":
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            for viewport_width in (360, 390, 430, 1024):
                context = browser.new_context(
                    viewport={"width": viewport_width, "height": 844},
                    service_workers="block",
                )
                page = context.new_page()
                page.set_default_timeout(7000)
                try:
                    check_width(page, viewport_width)
                    print(f"PASS recurring_types_ui {viewport_width}", flush=True)
                finally:
                    context.close()
        finally:
            browser.close()
