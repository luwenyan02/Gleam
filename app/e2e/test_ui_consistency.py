"""Shared actions, concise copy and compact periods; fictional browser data only."""
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from capture_readme import seed

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2]/'.tmp/tests/e2e/ui-consistency'


def open_mine(page, route):
    page.locator('.tab[data-page="page-mine"]').click()
    page.locator(f'#page-mine [data-sub="{route}"]').first.click()
    page.locator(f'#{route}.open').wait_for()


def back(page, route):
    page.locator(f'#{route} .sub-head [data-act="back"]').click()
    page.locator(f'#{route}').wait_for(state='detached')


def usable(page, selector):
    assert page.locator(selector).evaluate('e=>e.scrollWidth<=e.clientWidth+1'), selector
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')


def capture(page, selector, name, width, theme):
    usable(page, selector)
    page.wait_for_timeout(250)
    page.screenshot(path=str(OUT/f'{name}-{width}-{theme}.png'),animations='disabled')


def no_orphan(locator):
    lines=locator.evaluate('''element => {
      const counts=new Map(), walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
      for(let node=walker.nextNode();node;node=walker.nextNode()){
        for(let i=0;i<node.length;i++){
          if(/\\s/.test(node.textContent[i]))continue;
          const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);
          const box=range.getBoundingClientRect();if(!box.height)continue;
          const y=Math.round(box.y);counts.set(y,(counts.get(y)||0)+1);
        }
      }return [...counts.values()];
    }''')
    assert len(lines)<2 or lines[-1]>=4, (locator.inner_text(),lines)


def run(page,width,theme):
    seed(page)
    open_mine(page,'sp-settings')
    page.get_by_role('button',name='浅色' if theme=='light' else '深色',exact=True).click()
    expect(page.locator(f'[data-theme-mode="{theme}"]')).to_have_class('chip active')
    page.wait_for_timeout(250)
    voice=page.locator('section[aria-label="百炼短语音"]')
    voice.scroll_into_view_if_needed()
    status=voice.locator('.settings-status')
    button=voice.locator('[data-voice-test]')
    expect(status).to_have_text('仅 Android 可用')
    expect(status).to_be_visible()
    config=voice.locator('details.voice-web-details')
    expect(config).not_to_have_attribute('open','')
    expect(button).to_be_hidden()
    config.locator('summary').click()
    expect(button).to_be_visible()
    expect(button).to_be_disabled()
    for control in ('#voice-bailian-region','#voice-bailian-workspace','#voice-bailian-key'):
        expect(voice.locator(control)).to_be_disabled()
    radius=button.evaluate('e=>parseFloat(getComputedStyle(e).borderRadius)')
    reference=page.locator('[data-theme-mode="light"]').evaluate('e=>parseFloat(getComputedStyle(e).borderRadius)')
    assert abs(radius-reference)<.5,(radius,reference)
    capture(page,'#sp-settings','settings',width,theme)
    back(page,'sp-settings')
    open_mine(page,'sp-budget')
    controls=page.locator('.bd-period button')
    expect(controls).to_have_count(3)
    boxes=controls.evaluate_all('buttons=>buttons.map(b=>b.getBoundingClientRect().toJSON())')
    parent=page.locator('.bd-period').bounding_box()
    assert all(b['left']>=parent['x']-1 and b['right']<=parent['x']+parent['width']+1 for b in boxes),'预算操作不能藏在横向滚动区'
    assert max(b['y'] for b in boxes)-min(b['y'] for b in boxes)<2
    no_orphan(page.locator('#sp-budget .sub-body>p.tiny').last)
    capture(page,'#sp-budget','budget',width,theme)
    page.locator('#sp-budget [data-act="mode"]').click()
    page.locator('#sp-budget [data-act="setup"]').wait_for()
    capture(page,'#sp-budget','annual-budget',width,theme)
    back(page,'sp-budget')
    open_mine(page,'sp-tags')
    intro=page.locator('#sp-tags .sub-body>p.sub').first
    no_orphan(intro)
    assert '标签用于报表排行统计' not in intro.inner_text()
    for action in ('#tm-addtag','#tm-addshop'):
        assert abs(page.locator(action).evaluate('e=>parseFloat(getComputedStyle(e).borderRadius)')-reference)<.5
    capture(page,'#sp-tags','tags',width,theme)
    back(page,'sp-tags')
    page.locator('#tab-home').click()
    page.locator('#hm-quick [data-qa="ai"]').click()
    page.locator('#sp-ai-inbox .ai-input').wait_for()
    intro=page.locator('#sp-ai-inbox .ai-input>p.tiny')
    expect(intro).to_contain_text('AI 自动识别记账')
    expect(intro).not_to_contain_text('接口')
    no_orphan(intro)
    capture(page,'#sp-ai-inbox','ai-inbox',width,theme)
    back(page,'sp-ai-inbox')
    page.locator('.tab').filter(has_text='报表').click()
    page.locator('#trend-cap').wait_for()
    caption=page.locator('#trend-cap')
    expect(caption).not_to_contain_text('合计')
    expect(caption).not_to_contain_text('¥')
    no_orphan(caption)
    capture(page,'#page-report','report',width,theme)
    for route,name in [('sp-template-manage','templates'),('sp-backup','backup'),('sp-categories','categories'),('sp-recurring','recurring'),('sp-reimburse','reimburse'),('sp-loan','loan'),('sp-trash','trash')]:
        open_mine(page,route)
        capture(page,f'#{route}',name,width,theme)
        back(page,route)


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    widths=tuple(map(int,os.environ.get('GLEAM_UI_WIDTHS','360,390,430,1280').split(',')))
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width in widths:
            for theme in ('light','dark'):
                context=browser.new_context(viewport={'width':width,'height':844},locale='zh-CN',timezone_id='Asia/Shanghai',service_workers='block',reduced_motion='reduce')
                page=context.new_page()
                page.clock.install(time=datetime(2026,10,13,4,tzinfo=timezone.utc))
                origin=urlsplit(URL)
                context.route('**/*',lambda route:route.continue_() if urlsplit(route.request.url).netloc==origin.netloc else route.abort())
                errors=[]
                page.on('pageerror',lambda error:errors.append(str(error)))
                try:
                    page.goto(URL)
                    page.locator('#fab').wait_for()
                    run(page,width,theme)
                    assert not errors,errors
                    print(f'PASS common UI {width} {theme}',flush=True)
                finally:context.close()
        browser.close()


if __name__=='__main__':main()
