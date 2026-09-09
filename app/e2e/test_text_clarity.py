"""文字清晰度回归：字号/对比度/数字字形与窄屏可用性，使用虚构数据。"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
from test_list_rows_and_back import fixture

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4601/')
OUT=Path(os.environ.get('GLEAM_TEXT_SHOTS',Path(__file__).parents[2]/'.tmp/reports/text-clarity/after'))
OUT.mkdir(parents=True,exist_ok=True)

def text_style(page,selector):
    return page.evaluate('''selector=>{
      const e=document.querySelector(selector),s=getComputedStyle(e);
      const bg=getComputedStyle(e.closest('.card,.account-month')||document.querySelector('.app')).backgroundColor;
      return {size:parseFloat(s.fontSize),weight:s.fontWeight,color:s.color,font:s.fontFamily,bg};
    }''',selector)

def luminance(color):
    values=[float(v.strip())/255 for v in color[color.index('(')+1:color.index(')')].split(',')[:3]]
    linear=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in values]
    return sum(a*b for a,b in zip(linear,[.2126,.7152,.0722]))

def contrast(style):
    a,b=sorted([luminance(style['color']),luminance(style['bg'])]);return (b+.05)/(a+.05)

def run(page,width):
    fixture(page);page.wait_for_timeout(350)
    title=text_style(page,'#hm-days [data-entry-row="1"] .e-title')
    meta=text_style(page,'#hm-days [data-entry-row="1"] .e-meta')
    amount=text_style(page,'#hm-days [data-entry-row="1"] .e-amt')
    page.locator('#page-home').screenshot(path=str(OUT/f'home-{width}.png'))
    issues=[]
    if title['size']<15 or int(title['weight'])<500:issues.append('明细主文字小于15px或字重不足')
    if meta['size']<13:issues.append('日期账户文字小于13px')
    if contrast(meta)<7:issues.append('副文字未达到本轮7:1清晰度目标')
    if 'mono' in amount['font'].lower():issues.append('金额仍使用代码等宽字体')
    status_rects=page.evaluate('''()=>{
      const e=document.querySelector('#hm-days [data-entry-row="7"] .e-meta');
      const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);
      for(let node=walker.nextNode();node;node=walker.nextNode()){
        const start=node.textContent.indexOf('已报销');if(start<0)continue;
        const r=document.createRange();r.setStart(node,start);r.setEnd(node,start+3);return r.getClientRects().length;
      }return 0;
    }''')
    if status_rects!=1:issues.append('已报销等短状态词不应拆成单字换行')
    page.locator('.tab[data-page="page-acct"]').click();page.locator('[data-acct="1"]').click()
    page.locator('.account-entry-balance').first.wait_for();page.wait_for_timeout(350)
    balance=text_style(page,'.account-entry-balance')
    if balance['size']<13:issues.append('逐笔余额小于13px')
    assert page.locator('.account-entry-amounts').evaluate_all('els=>els.every(e=>e.scrollWidth<=e.clientWidth+1)'), '金额/余额不能溢出'
    page.locator('.account-month.expanded').evaluate('e=>e.scrollIntoView({block:"start"})')
    page.screenshot(path=str(OUT/f'account-{width}.png'))
    page.locator('#sp-account-detail [data-act="back"]').click();page.locator('#sp-account-detail').wait_for(state='detached')
    page.locator('#tab-home').click();page.locator('#fab').click()
    page.locator('#keypad').wait_for();page.wait_for_timeout(350)
    key=text_style(page,'#keypad [data-k="1"]')
    if 'mono' in key['font'].lower():issues.append('数字键盘仍使用代码字体')
    cat=text_style(page,'#cat-grid .cat')
    if cat['size']<12:issues.append('常用分类小于12px')
    assert page.locator('#keypad [data-k="save"]').evaluate('e=>e.getBoundingClientRect().bottom<=innerHeight'), '保存按钮不可被挤出屏幕'
    page.screenshot(path=str(OUT/f'entry-{width}.png'))
    page.locator('#sheet-close').click();page.locator('#sheet.open').wait_for(state='detached');page.wait_for_timeout(350)
    page.evaluate("document.documentElement.setAttribute('data-theme','dark')");page.wait_for_timeout(250)
    dark=text_style(page,'#hm-days [data-entry-row="1"] .e-meta')
    if contrast(dark)<7:issues.append('深色副文字对比度不足')
    page.locator('#page-home').screenshot(path=str(OUT/f'dark-{width}.png'))
    return {'width':width,'title':title,'meta':meta,'amount':amount,'balance':balance,'key':key,'category':cat,'dark':dark,'contrast':round(contrast(meta),2),'darkContrast':round(contrast(dark),2),'issues':issues}

if __name__=='__main__':
    results=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        for width in (360,390,430,1024):
            ctx=browser.new_context(viewport={'width':width,'height':844},service_workers='block')
            page=ctx.new_page();page.set_default_timeout(7000)
            try:
                page.goto(URL);page.wait_for_load_state('networkidle');page.locator('#fab').wait_for()
                result=run(page,width);results.append(result)
                print('FAIL' if result['issues'] else 'PASS',width,json.dumps(result,ensure_ascii=False),flush=True)
            finally:ctx.close()
        browser.close()
    (OUT/'metrics.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    raise SystemExit(1 if any(r['issues'] for r in results) else 0)
