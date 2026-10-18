"""Upgrade a populated v4 IndexedDB without rewriting financial records; fictional data."""
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from test_entry_detail_performance import SEED, URL

SCHEMA='''async()=>{
 const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
 const names=Array.from(db.objectStoreNames),tx=db.transaction(names);
 const stores=names.map(name=>{const s=tx.objectStore(name);return {name,keyPath:s.keyPath,autoIncrement:s.autoIncrement,indexes:Array.from(s.indexNames).filter(n=>n!=='refundOfEntryId').map(name=>{const i=s.index(name);return {name,keyPath:i.keyPath,unique:i.unique,multiEntry:i.multiEntry}})}});
 const settings=await new Promise(r=>{const q=tx.objectStore('settings').getAll();q.onsuccess=()=>r(q.result)});
 db.close();return {stores,settings};
}'''
LEGACY='''async({stores,settings})=>{
 await new Promise((resolve,reject)=>{const q=indexedDB.deleteDatabase('GleamDB');q.onsuccess=resolve;q.onerror=()=>reject(q.error)});
 const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('GleamDB',40);q.onupgradeneeded=()=>{
  for(const s of stores){const store=q.result.createObjectStore(s.name,{keyPath:s.keyPath,autoIncrement:s.autoIncrement});for(const i of s.indexes)store.createIndex(i.name,i.keyPath,{unique:i.unique,multiEntry:i.multiEntry})}
 };q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)});
 const tx=db.transaction('settings','readwrite');for(const row of settings)tx.objectStore('settings').put(row);
 await new Promise(r=>tx.oncomplete=r);db.close();
}'''
SNAPSHOT='''async()=>{
 const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
 const names=['entries','accounts','categories','merchants','tags','entryTags'],tx=db.transaction(names);
 const data=await Promise.all(names.map(name=>new Promise(r=>{const q=tx.objectStore(name).getAll();q.onsuccess=()=>r(q.result)})));
 const version=db.version;db.close();const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data)));
 return {version,digest:Array.from(new Uint8Array(hash)).map(n=>n.toString(16).padStart(2,'0')).join(''),counts:data.map(rows=>rows.length)};
}'''

if __name__=='__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch();context=browser.new_context(viewport={'width':400,'height':890},device_scale_factor=3,service_workers='block')
        errors=[];page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        context.route('**/*',lambda r:r.continue_() if urlsplit(r.request.url).netloc==urlsplit(URL).netloc else r.abort())
        page.goto(URL);page.locator('#fab').wait_for();schema=page.evaluate(SCHEMA)
        fixture=URL.rstrip('/')+'/__entry_upgrade_fixture'
        page.route(fixture,lambda r:r.fulfill(content_type='text/html',body='<html><title>Isolated upgrade fixture</title></html>'))
        page.goto(fixture);page.evaluate(LEGACY,schema);page.evaluate(SEED);before=page.evaluate(SNAPSHOT)
        assert before['version']==40
        page.goto(URL);page.locator('#fab').wait_for();after=page.evaluate(SNAPSHOT)
        assert after['version']==50 and before['digest']==after['digest'] and before['counts']==after['counts'],(before,after)
        page.locator('#hm-days [data-entry="1"]').click();expect(page.locator('#sp-entry-view .refund-links')).to_contain_text('85.00')
        assert not errors,errors
        browser.close();print('PASS v4 -> v5: 20,001 entries, balances and metadata preserved; historical refund index populated',flush=True)
