"""Real backup restore progress and late-batch rollback, using only fictional ledgers."""
import hashlib
import json
import os
import time
import zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from test_acceptance_fixes import seed

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/restore-progress'
ROWS = 200000 if os.environ.get('GLEAM_RESTORE_LARGE') == '1' else 20000
READ = '''async()=>{const db=await new Promise(res=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>res(q.result)});
const names=[...db.objectStoreNames],tx=db.transaction(names,'readonly');
const data=await Promise.all(names.map(n=>new Promise(res=>{const q=tx.objectStore(n).getAll();q.onsuccess=()=>res([n,q.result])})));db.close();return Object.fromEntries(data)}'''
FAIL_LATE = '''(() => { const add=IDBObjectStore.prototype.add; IDBObjectStore.prototype.add=function(value,...args){
if(window.__failRestore && this.name==='entries' && value.id===1501) value={...value,id:1};
return add.call(this,value,...args); }; })();'''

def archive(dump, count):
    original = dump['entries'][0]
    # Old dates keep the home timeline bounded after restoring.
    dump['entries'] = [{**original, 'id': i+1, 'occurredAt': 1577836800000+i*1000, 'note': '虚构恢复测试'} for i in range(count)]
    dump['accounts'][0]['balance'] = -100*count
    raw = json.dumps(dump, ensure_ascii=False, separators=(',', ':')).encode()
    manifest = dict(app='拾光', appVersion='1.11.37', schemaVersion=5, generatedAt=int(time.time()*1000),
        counts={k: len(v) for k,v in dump.items()}, checksum=hashlib.sha256(raw).hexdigest(), attachmentChecksums={})
    path = OUT/f'fictional-{count}.skbak'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(manifest));z.writestr('data.json', raw)
    return path

def restore(page, path):
    with page.expect_file_chooser() as fc:page.locator('#sp-backup [data-act="restore"]').click()
    fc.value.set_files(str(path))
    page.get_by_text('确认恢复此备份？',exact=True).wait_for(timeout=30000)
    page.locator('#dialog-scrim [data-act="ok"]').click()

def run(browser, width, dark, count, fail=False):
    ctx=browser.new_context(viewport={'width':width,'height':890},device_scale_factor=3 if width==400 else 1,
        service_workers='block',timezone_id='Asia/Shanghai')
    ctx.add_init_script(FAIL_LATE)
    ctx.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc==urlsplit(URL).netloc else r.abort())
    page=ctx.new_page()
    if ROWS == 200000:
        page.on('console', lambda message: print(message.text, flush=True) if message.text.startswith('RESTORE_PROGRESS ') else None)
        page.add_init_script("""addEventListener('DOMContentLoaded',()=>{
          let last=0; new MutationObserver(()=>{
            const progress=document.querySelector('.restore-progress progress');
            if(progress && progress.value>=last+10000){last=progress.value;console.log('RESTORE_PROGRESS '+progress.value+'/'+progress.max);}
          }).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
        });""")
    page.goto(URL);page.locator('#fab').wait_for();seed(page,count=1,amount=100)
    before=page.evaluate(READ);path=archive(json.loads(json.dumps(before)),count)
    if dark:page.evaluate('document.documentElement.dataset.theme="dark";document.documentElement.style.setProperty("--seed-type","1.3")')
    page.locator('.tab[data-page="page-mine"]').click();page.locator('#page-mine [data-sub="sp-backup"]').click()
    if fail:page.evaluate('window.__failRestore=true')
    start=time.monotonic();restore(page,path)
    if not fail:
        progress=page.locator('.restore-progress');expect(progress).to_be_visible(timeout=10000)
        page.keyboard.press('Escape')
        expect(progress).to_be_visible()
        page.wait_for_function('!!history.state?.gleamLayer')
        marker = page.evaluate('history.state.gleamLayer')
        for _ in range(3):
            page.evaluate("() => new Promise(resolve => { addEventListener('popstate', () => resolve(null), {once:true}); history.back(); })")
            page.wait_for_function('marker => history.state?.gleamLayer === marker', arg=marker)
            expect(progress).to_be_visible()
        page.screenshot(path=str(OUT/f'progress-{width}-{dark}.png'),animations='disabled')
        assert progress.locator('.dialog').evaluate('e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}')
        page.get_by_text('恢复完成',exact=True).wait_for(timeout=1800000 if ROWS == 200000 else 180000)
        expect(page.locator('#dialog-scrim')).to_contain_text(str(count))
        page.locator('#dialog-scrim [data-act="ok"]').click()
        expect(progress).to_have_count(0)
        after=page.evaluate(READ)
        assert len(after['entries'])==count
        assert after['accounts'][0]['balance']==-100*count
        expect(page.locator('#sp-backup')).to_contain_text(f'{count:,} 笔有效账单')
        page.locator('#sp-backup .sub-head [data-act="back"]').click()
        expect(page.locator('#page-mine')).to_be_visible()
    else:
        page.get_by_text('恢复未完成',exact=True).wait_for(timeout=30000)
        expect(page.locator('#dialog-scrim')).to_contain_text('原数据未被替换')
        after=page.evaluate(READ)
        assert after['entries']==before['entries'] and after['accounts']==before['accounts']
        expect(page.locator('.restore-progress')).to_have_count(0)
    print('PASS restore',dict(width=width,dark=dark,rows=count,rollback=fail,seconds=round(time.monotonic()-start,2)),flush=True)
    ctx.close()

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as p:
        b=p.chromium.launch()
        run(b,400,False,ROWS)
        if ROWS==20000:
            run(b,360,True,20000)
            run(b,400,False,2001,True)
        b.close()
