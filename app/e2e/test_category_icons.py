"""Imported placeholder icons render by category without changing stored choices."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/category-icons'
CASES = {
    'expense': [('饮料水果','ic-fruit'), ('羽毛球','ic-pulse'), ('停车费','ic-park'),
                ('网游电玩','ic-film'), ('家居百货','ic-bottle'), ('夜宵','ic-moon'),
                ('服饰鞋包','ic-shirt'), ('电子数码','ic-camera'), ('打车','ic-car'),
                ('飞机','ic-plane'), ('地铁','ic-metro'), ('午餐','ic-bowl'),
                ('晚餐','ic-moon'), ('零食','ic-cone'), ('早餐','ic-sun'),
                ('保养维修','ic-set'), ('买菜原料','ic-cart'), ('住宿房租','ic-house')],
    'income': [('利息','ic-coin'), ('报销款','ic-file'), ('公积金','ic-house'),
               ('工资薪水','ic-brief'), ('其他','ic-wallet'), ('红包','ic-gift'), ('报销','ic-file')],
}

def run(page, width):
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL); page.locator('#fab').wait_for()
    page.evaluate('''async cases => {
      const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
      const tx=db.transaction('categories','readwrite'), store=tx.objectStore('categories');
      store.clear(); let id=1;
      for(const [kind,items] of Object.entries(cases)) for(const [name] of items)
        store.put({id:id++,name,kind,icon:kind==='expense'?'ic-tag':'ic-coin',sortOrder:id,createdAt:1,updatedAt:1});
      store.put({id:100,name:'自选图标',kind:'income',icon:'ic-cup',sortOrder:100,createdAt:1,updatedAt:1});
      await new Promise(resolve=>tx.oncomplete=resolve); db.close();
    }''', CASES)
    page.reload(); page.locator('#fab').click()
    for kind, items in CASES.items():
        page.locator(f'#seg [data-type="{kind}"]').click()
        for name, icon in items:
            button = page.locator('#cat-grid').get_by_role('option', name=name, exact=True)
            expect(button.locator('use')).to_have_attribute('href', '#'+icon)
            button.click()
            expect(page.locator('#pick-ic use')).to_have_attribute('href', '#'+icon)
        if kind == 'income':
            expect(page.locator('#cat-grid').get_by_role('option',name='自选图标').locator('use')).to_have_attribute('href','#ic-cup')
        for theme in ('light','dark'):
            page.evaluate('(theme)=>document.documentElement.dataset.theme=theme', theme)
            page.screenshot(path=str(OUT/f'{kind}-{theme}-{width}.png'), animations='disabled')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
    assert not errors, errors
    print(f'PASS category icons {width}', flush=True)

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360,390,430,1280):
            context = browser.new_context(viewport={'width':width,'height':900}, service_workers='block', reduced_motion='reduce')
            run(context.new_page(), width); context.close()
        browser.close()
