"""Illustrated financial cards: rendered contrast, readable values and controls."""
import base64
import os
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from capture_readme import seed

URL=os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4617/')
OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/overview-art'


def contrast_card(page,selector,text_selectors):
    card=page.locator(selector)
    records=card.evaluate('''(card, selectors) => {
      const origin=card.getBoundingClientRect();
      return selectors.flatMap(selector=>[...card.querySelectorAll(selector)].map(element=>{
        const range=document.createRange();range.selectNodeContents(element);
        const r=range.getBoundingClientRect(),s=getComputedStyle(element);
        return {x:r.x-origin.x,y:r.y-origin.y,width:r.width,height:r.height,
          color:s.color,fontSize:parseFloat(s.fontSize),text:element.textContent};
      }));
    }''',text_selectors)
    hide=page.add_style_tag(content=f'{selector}>* {{visibility:hidden!important}}')
    try:
        png=base64.b64encode(card.screenshot(animations='disabled')).decode()
    finally:hide.evaluate('e=>e.remove()')
    # Sample the actual rendered background via the browser, with no extra
    # image-processing dependency and no screenshot pixel modifications.
    results=page.evaluate('''async ({png,records})=>{
      const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));
      const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
      const lum=rgb=>rgb.slice(0,3).reduce((sum,c,i)=>{
        const v=c/255;return sum+(v<=.04045?v/12.92:((v+.055)/1.055)**2.4)*[.2126,.7152,.0722][i];
      },0);
      return records.map(r=>{
        const samples=[];
        for(let x of [r.x+2,r.x+r.width/2,r.x+r.width-2])for(let y of [r.y+2,r.y+r.height/2,r.y+r.height-2]){
          x=Math.max(0,Math.min(canvas.width-1,Math.floor(x)));y=Math.max(0,Math.min(canvas.height-1,Math.floor(y)));
          samples.push(1.05/(lum([...ctx.getImageData(x,y,1,1).data])+.05));
        }return Math.min(...samples);
      });
    }''',{'png':png,'records':records})
    for record,minimum in zip(records,results):
        assert record['color']=='rgb(255, 255, 255)',record
        required=3 if record['fontSize']>=24 else 4.5
        assert minimum>=required,(record,minimum,required)
    return [round(result,2) for result in results]


def run(page,width,theme):
    seed(page)
    page.evaluate('''async mode=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const tx=db.transaction('settings','readwrite');
      tx.objectStore('settings').put({key:'theme.mode',value:mode,updatedAt:Date.now()});
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
      localStorage.setItem('gleam-theme',mode);
    }''',theme)
    page.reload()
    page.locator('#m-spend').wait_for()
    home=page.locator('.mc-overview')
    expect(home).to_have_css('color','rgb(255, 255, 255)')
    assert 'home-overview.webp' in home.evaluate('e=>getComputedStyle(e).backgroundImage')
    amounts=['2,482.00','12,000.00','9,518.00','3,518.00']
    values=page.locator('#m-spend,#m-income,#m-balance,#m-remain')
    expect(values).to_have_text(amounts)
    before=page.evaluate('localStorage.getItem("gleam-theme")')
    home_contrast=contrast_card(page,'.mc-overview',['.mc-label','.mc-unit','#m-spend'])
    page.locator('#page-home').screenshot(path=str(OUT/f'home-{width}-{theme}.png'),animations='disabled')
    page.locator('.tab[data-page="page-acct"]').click()
    page.get_by_role('button', name='显示金额', exact=True).click()
    expect(page.locator('.asset-summary .big')).to_be_visible()
    asset=page.locator('.asset-summary')
    assert 'account-overview.webp' in asset.evaluate('e=>getComputedStyle(e).backgroundImage')
    page.locator('#page-acct').screenshot(path=str(OUT/f'account-{width}-{theme}.png'),animations='disabled')
    asset_contrast=contrast_card(page,'.asset-summary',['.label','.big','.asset-row p','.asset-row .num'])
    expect(page.locator('.acct-hero .balance-trend')).not_to_have_attribute('open','')
    page.locator('.acct-hero .balance-trend-heading').click()
    expect(page.locator('.acct-hero .balance-trend-chart')).to_be_visible()
    assert page.locator('.acct-hero').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
    page.locator('#page-acct').screenshot(path=str(OUT/f'account-expanded-{width}-{theme}.png'),animations='disabled')
    page.locator('#tab-home').click()
    expect(values).to_have_text(amounts)
    assert page.evaluate('localStorage.getItem("gleam-theme")')==before
    page.route('**/art/*.webp',lambda route:route.abort())
    page.reload()
    page.locator('#fab').wait_for()
    expect(values).to_have_text(amounts)
    assert page.locator('.mc-overview').evaluate('e=>getComputedStyle(e).backgroundColor')!='rgba(0, 0, 0, 0)'
    print(f'PASS overview art {width} {theme}; contrast {home_contrast}/{asset_contrast}; retained amounts and fallback',flush=True)


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        browser=p.chromium.launch()
        widths=tuple(map(int,os.environ.get('GLEAM_UI_WIDTHS','360,390,430,1280').split(',')))
        for width in widths:
            for theme in ('light','dark'):
                context=browser.new_context(viewport={'width':width,'height':844},timezone_id='Asia/Shanghai',locale='zh-CN',service_workers='block',reduced_motion='reduce')
                page=context.new_page()
                page.clock.install(time=datetime(2026,10,13,4,tzinfo=timezone.utc))
                try:
                    page.goto(URL)
                    page.locator('#fab').wait_for()
                    run(page,width,theme)
                finally:context.close()
        browser.close()


if __name__=='__main__':main()
