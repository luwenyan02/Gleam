"""备注联动：全虚构IndexedDB与原生拉取桥，不调用真实模型或读取备份。"""
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from test_short_voice import MOCK_NATIVE
from test_life_ai import read_rows

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4618/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/note-decision'
BRIDGE = r'''(() => {
 const native=window.Capacitor.nativePromise.bind(window.Capacitor);
 window.Capacitor.PluginHeaders.push({name:'GleamAiStream',methods:['start','read','cancel'].map(name=>({name,rtype:'promise'}))});
 window.__decisions=[];window.__decisionCancels=[];window.__decisionChecks=0;
 window.Capacitor.nativePromise=async(plugin,method,options={})=>{
  if(plugin==='GleamSecrets'&&method==='get'&&options.key==='ai.apiKey')window.__decisionChecks++;
  if(plugin!=='GleamAiStream')return native(plugin,method,options);
  if(method==='start'){
   const row={id:options.id,url:options.url,request:JSON.parse(options.body),released:false,read:false,done:false};
   window.__decisions.push(row);return {status:200,contentType:'application/json'};
  }
  const row=window.__decisions.find(r=>r.id===options.id);
  if(method==='cancel'){window.__decisionCancels.push(options.id);return {};}
  if(method==='read'){
   if(row.read){row.done=true;return {done:true};}
   row.read=true;return await new Promise(resolve=>{row.release=(category,account,confidence=.99)=>{
    const answer=(field,choice)=>({type:'choice',choice,confidence,probabilities:Object.fromEntries(Object.keys(row.request.questions[field].criteria).map(key=>[key,choice==='unknown'?(key==='unknown'?1:0):key===choice?.99:key==='unknown'?.01:0]))});
    row.released=true;resolve({done:false,dataBase64:btoa(JSON.stringify({answers:{category:answer('category',category),account:answer('account',account)}}))});
   };});
  }
 };
})();'''
SEED = r'''async ({theme,ambiguous=false})=>{
 const db=await new Promise(resolve=>{const r=indexedDB.open('GleamDB');r.onsuccess=()=>resolve(r.result)});
 const tx=db.transaction(['categories','accounts','entries','settings'],'readwrite');const stamp={createdAt:1,updatedAt:1};
 for(const table of ['categories','accounts','entries'])tx.objectStore(table).clear();
 for(const [id,name] of [[1,'午餐'],[2,'服饰鞋包'],[3,'家用电器']])tx.objectStore('categories').put({...stamp,id,name,kind:'expense',icon:'ic-coin',sortOrder:id});
 const accounts=[[1,'中信信用卡','credit'],[2,'广发信用卡','credit']];if(ambiguous)accounts.push([3,'中信储蓄卡','debit']);
 for(const [id,name,group] of accounts)tx.objectStore('accounts').put({...stamp,id,name,group,balance:100000,hidden:false,countInNetWorth:true,sortOrder:id});
 const now=Date.now();
 for(const [id,age] of [[81,1],[82,3],[83,10]])tx.objectStore('entries').put({...stamp,id,type:'expense',amount:8800,categoryId:2,accountId:2,occurredAt:now-age*86400000,note:'旧衣服，广发银行',deletedAt:0,reimburseStatus:'none'});
 for(const [key,value] of [['theme.mode',theme],['ai.noteDecision.enabled',true],['ai.noteDecision.workspace','synthetic-space'],['ai.noteDecision.region','beijing'],['ai.baseUrl','https://dashscope.aliyuncs.com/compatible-mode/v1']])tx.objectStore('settings').put({key,value,updatedAt:1});
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
}'''


def frames(page):
    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')


def begin(page, text):
    before = page.evaluate('window.__decisions.length')
    page.locator('#note').fill(text)
    page.locator('#note').blur()
    page.wait_for_function('(n)=>window.__decisions.length===n+1&&!!window.__decisions[n].release', arg=before)
    return before


def release(page, index, category='c_1', account='a_1', confidence=.99, cancelled=False):
    checks = page.evaluate('window.__decisionChecks')
    page.evaluate('([i,c,a,p])=>window.__decisions[i].release(c,a,p)', [index, category, account, confidence])
    if not cancelled:
        page.wait_for_function('(n)=>window.__decisionChecks>n', arg=checks)
    frames(page)


def open_new(page):
    page.locator('#fab').click()
    page.locator('#sheet.open #note').wait_for()


def close_sheet(page):
    page.locator('#sheet-close').click()
    page.locator('#sheet.open').wait_for(state='detached')


def choose_account(page, account):
    page.locator('#acct-btn').click()
    page.locator(f'.entry-account-picker [data-account="{account}"]').click()
    page.locator('.entry-account-mask').wait_for(state='detached')


def selection(page):
    return page.locator('#pick-name').inner_text(), page.locator('#acct-name').inner_text()


def snapshot(page, name, width):
    page.locator('#toast.show').wait_for(state='hidden')
    if name in ('settings', 'web-disabled'):
        page.locator('[data-settings-detail="note-decision"]').scroll_into_view_if_needed()
    frames(page)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    assert page.locator('#sheet').evaluate('el=>el.scrollWidth<=el.clientWidth+1') if page.locator('#sheet.open').count() else True
    for selector in ('#note-decision-undo', '#acct-btn', '#sheet-close', '#note-decision-enabled', '#note-decision-region', '#note-decision-workspace'):
        item = page.locator(selector)
        if item.count() and item.is_visible():
            box = item.bounding_box()
            assert box['width'] >= 44 and box['height'] >= 44, (selector, box)
    page.screenshot(path=str(OUT / f'{name}-{width}.png'), animations='disabled')


def settings(page):
    page.locator('[data-page="page-mine"]').click()
    page.get_by_role('button', name='应用设置', exact=True).click()
    page.locator('[data-settings-detail="note-decision"] summary').click()
    page.locator('#note-decision-enabled').wait_for()


def leave_settings(page):
    page.locator('#sp-settings [data-act="back"]').click()
    page.locator('[data-page="page-home"]').click()


def native_run(browser, width, theme='light', scale=1):
    context = browser.new_context(viewport={'width': width, 'height': 900}, timezone_id='Asia/Shanghai', service_workers='block', reduced_motion='reduce')
    page = context.new_page()
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(MOCK_NATIVE + ';\n' + BRIDGE)
    def route_request(route):
        if urlparse(route.request.url).netloc == urlparse(URL).netloc:
            route.continue_()
        else:
            external.append(route.request.url)
            route.abort()
    page.route('**/*', route_request)
    try:
        page.goto(URL); page.locator('#fab').wait_for()
        page.evaluate(SEED, {'theme': theme})
        originals = read_rows(page, 'entries')
        page.reload(); page.locator('#hm-days [data-entry="81"]').wait_for()
        page.evaluate('([theme,scale])=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty("--seed-type",scale)}', [theme, str(scale)])

        # Automatic fields are a draft patch only. Undo restores both and suppresses reapplication.
        open_new(page); initial = selection(page)
        assert initial == ('服饰鞋包', '广发信用卡'), initial
        index = begin(page, '肯德基23元，中信银行')
        assert selection(page) == initial
        release(page, index)
        expect(page.locator('#pick-name')).to_have_text('午餐')
        expect(page.locator('#acct-name')).to_have_text('中信信用卡')
        expect(page.locator('#note-decision-result')).to_be_visible()
        assert read_rows(page, 'entries') == originals
        snapshot(page, 'automatic', width)
        page.locator('#note-decision-undo').click()
        assert selection(page) == initial
        expect(page.locator('#note-decision-result')).to_be_hidden()
        page.locator('#note').focus(); page.locator('#note').blur(); frames(page)
        assert page.evaluate('window.__decisions.length') == index + 1
        close_sheet(page)

        # Copy initially keeps the source; merely focusing/blurring cannot send it.
        page.locator('#hm-days [data-entry="81"]').click()
        page.locator('#sp-entry-view [data-view-action="copy"]').click()
        page.locator('#sheet.open #note').wait_for()
        count = page.evaluate('window.__decisions.length')
        page.locator('#note').focus(); page.locator('#note').blur(); frames(page)
        assert page.evaluate('window.__decisions.length') == count
        index = begin(page, '洗衣机，广发银行')
        release(page, index, 'c_3', 'a_2')
        expect(page.locator('#pick-name')).to_have_text('家用电器')
        # A second changed note can replace the copied account too.
        index = begin(page, '洗衣机，中信信用卡')
        release(page, index, 'c_3', 'a_1')
        expect(page.locator('#acct-name')).to_have_text('中信信用卡')
        assert read_rows(page, 'entries') == originals
        snapshot(page, 'copy', width)
        close_sheet(page)
        page.locator('#sp-entry-view .sub-head [data-act="back"]').click()
        page.locator('#sp-entry-view').wait_for(state='detached')

        # Manual choices made before the request are independent hard locks.
        open_new(page)
        page.locator('#cat-grid .cat[data-id="3"]').click()
        index = begin(page, '肯德基23元，中信银行')
        release(page, index)
        expect(page.locator('#pick-name')).to_have_text('家用电器')
        expect(page.locator('#acct-name')).to_have_text('中信信用卡')
        choose_account(page, 2)
        count = page.evaluate('window.__decisions.length')
        page.locator('#note').fill('肯德基24元，中信银行'); page.locator('#note').blur(); frames(page)
        assert page.evaluate('window.__decisions.length') == count
        assert selection(page) == ('家用电器', '广发信用卡')
        close_sheet(page)

        # An account chosen before inference is protected while the category can still change.
        open_new(page); choose_account(page, 2)
        index = begin(page, '肯德基24.5元，中信银行')
        release(page, index)
        expect(page.locator('#pick-name')).to_have_text('午餐')
        expect(page.locator('#acct-name')).to_have_text('广发信用卡')
        page.locator('#note-decision-undo').click()
        assert selection(page) == ('服饰鞋包', '广发信用卡')
        close_sheet(page)

        # A manual selection during a pending request cancels it and is never overwritten.
        open_new(page); index = begin(page, '肯德基25元，中信银行')
        page.locator('#cat-grid .cat[data-id="3"]').click()
        page.wait_for_function('(i)=>window.__decisionCancels.includes(window.__decisions[i].id)', arg=index)
        after_manual = selection(page)
        release(page, index, cancelled=True)
        assert selection(page) == after_manual
        expect(page.locator('#note-decision-result')).to_be_hidden()
        close_sheet(page)

        # Changing the account in flight cancels the request just like category selection.
        open_new(page); index = begin(page, '肯德基25.5元，中信银行')
        choose_account(page, 1)
        page.wait_for_function('(i)=>window.__decisionCancels.includes(window.__decisions[i].id)', arg=index)
        after_manual = selection(page)
        release(page, index, cancelled=True)
        assert selection(page) == after_manual
        expect(page.locator('#note-decision-result')).to_be_hidden()
        close_sheet(page)

        # A later note wins even when an older native read resolves afterwards.
        open_new(page); old = begin(page, '肯德基26元，中信银行')
        new = begin(page, '洗衣机，广发银行')
        release(page, new, 'c_3', 'a_2')
        expect(page.locator('#pick-name')).to_have_text('家用电器')
        release(page, old, cancelled=True)
        assert selection(page) == ('家用电器', '广发信用卡')
        close_sheet(page)

        # Low confidence and unknown return no status or alternate recommendation UI.
        for confidence, category, account in [(0.5, 'c_1', 'a_1'), (.99, 'unknown', 'unknown')]:
            open_new(page); before = selection(page)
            index = begin(page, '肯德基27元，中信银行')
            release(page, index, category, account, confidence)
            assert selection(page) == before
            expect(page.locator('#note-decision-result')).to_be_hidden()
            close_sheet(page)

        # Saving and closing both cancel pending inference; no extra bill is created.
        open_new(page); page.locator('#keypad [data-k="2"]').click()
        index = begin(page, '肯德基28元，中信银行')
        before = selection(page)
        page.locator('#keypad [data-k="save"]').click()
        page.locator('#sheet.open').wait_for(state='detached')
        page.wait_for_function('(i)=>window.__decisionCancels.includes(window.__decisions[i].id)', arg=index)
        release(page, index, cancelled=True)
        saved = read_rows(page, 'entries')
        assert len(saved) == len(originals) + 1
        latest = max(saved, key=lambda row: row['id'])
        assert latest['amount'] == 200 and latest['categoryId'] == 2 and latest['accountId'] == 2, (before, latest)
        open_new(page); index = begin(page, '肯德基29元，中信银行')
        close_sheet(page)
        page.wait_for_function('(i)=>window.__decisionCancels.includes(window.__decisions[i].id)', arg=index)
        release(page, index, cancelled=True)
        assert read_rows(page, 'entries') == saved

        # 再记 starts a fresh recommendation session even though the sheet stays open.
        open_new(page)
        repeat_note = '肯德基31元，中信银行'
        index = begin(page, repeat_note)
        release(page, index)
        expect(page.locator('#pick-name')).to_have_text('午餐')
        expect(page.locator('#acct-name')).to_have_text('中信信用卡')
        page.locator('#keypad [data-k="3"]').click()
        page.locator('#keypad [data-k="again"]').click()
        expect(page.locator('#note')).to_have_value('')
        expect(page.locator('#amt')).to_have_text('0.00')
        expect(page.locator('#keypad [data-k="again"]')).to_be_enabled()
        expect(page.locator('#note-decision-result')).to_be_hidden()
        first_repeat_saved = read_rows(page, 'entries')
        assert len(first_repeat_saved) == len(originals) + 2
        first_repeat = max(first_repeat_saved, key=lambda row: row['id'])
        assert (first_repeat['amount'], first_repeat['categoryId'], first_repeat['accountId'], first_repeat['note']) == (300, 1, 1, repeat_note)
        # Re-entering the identical note must issue a new request instead of deduplicating across bills.
        index = begin(page, repeat_note)
        release(page, index)
        assert read_rows(page, 'entries') == first_repeat_saved
        page.locator('#cat-grid .cat[data-id="3"]').click()
        choose_account(page, 2)
        page.locator('#keypad [data-k="4"]').click()
        page.locator('#keypad [data-k="again"]').click()
        expect(page.locator('#note')).to_have_value('')
        expect(page.locator('#amt')).to_have_text('0.00')
        expect(page.locator('#keypad [data-k="again"]')).to_be_enabled()
        expect(page.locator('#note-decision-result')).to_be_hidden()
        second_repeat_saved = read_rows(page, 'entries')
        assert len(second_repeat_saved) == len(originals) + 3
        second_repeat = max(second_repeat_saved, key=lambda row: row['id'])
        assert (second_repeat['amount'], second_repeat['categoryId'], second_repeat['accountId']) == (400, 3, 2)
        assert selection(page) == ('家用电器', '广发信用卡')
        index = begin(page, repeat_note)
        release(page, index)
        # Previous bill's hand selections are copied initial values, not locks on this new draft.
        expect(page.locator('#pick-name')).to_have_text('午餐')
        expect(page.locator('#acct-name')).to_have_text('中信信用卡')
        expect(page.locator('#note-decision-result')).to_be_visible()
        assert read_rows(page, 'entries') == second_repeat_saved
        snapshot(page, 'repeat', width)
        close_sheet(page)

        # The opt-in can be switched off; subsequent draft notes never reach native transport.
        settings(page)
        expect(page.locator('#note-decision-enabled')).to_have_attribute('aria-checked', 'true')
        snapshot(page, 'settings', width)
        page.locator('#note-decision-enabled').click()
        expect(page.locator('#note-decision-enabled')).to_have_attribute('aria-checked', 'false')
        leave_settings(page)
        open_new(page); count = page.evaluate('window.__decisions.length')
        page.locator('#note').fill('洗衣机，中信银行'); page.locator('#note').blur(); frames(page)
        assert page.evaluate('window.__decisions.length') == count
        close_sheet(page)
        settings(page); page.locator('#note-decision-enabled').click()
        expect(page.locator('#note-decision-enabled')).to_have_attribute('aria-checked', 'true')
        leave_settings(page)

        # Same-bank ambiguity is independently rejected even if the simulated model is certain.
        page.evaluate('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const tx=db.transaction('accounts','readwrite');tx.objectStore('accounts').put({id:3,name:'中信储蓄卡',group:'debit',balance:100000,hidden:false,countInNetWorth:true,sortOrder:3,createdAt:1,updatedAt:1});await new Promise(r=>tx.oncomplete=r);db.close()}''')
        open_new(page); before = selection(page)
        index = begin(page, '肯德基30元，中信银行')
        release(page, index, 'unknown', 'a_1')
        assert selection(page) == before
        expect(page.locator('#note-decision-result')).to_be_hidden()
        snapshot(page, 'ambiguous', width)
        close_sheet(page)
        assert len(read_rows(page, 'entries')) == len(originals) + 3
        assert [row for row in read_rows(page, 'entries') if row['id'] in (81, 82, 83)] == originals
        assert not errors, errors
        assert not external, external
        print('PASS note recommendation native', width, theme, scale, flush=True)
    except Exception:
        page.screenshot(path=str(OUT / f'failure-{width}.png'), animations='disabled')
        raise
    finally:
        context.close()


def web_run(browser):
    context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block', reduced_motion='reduce')
    page = context.new_page()
    page.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).netloc == urlparse(URL).netloc else route.abort())
    page.goto(URL); page.locator('#fab').wait_for()
    settings(page)
    expect(page.locator('#note-decision-enabled')).to_be_disabled()
    expect(page.locator('#note-decision-workspace')).to_be_disabled()
    expect(page.locator('[data-settings-detail="note-decision"]')).to_contain_text('仅 Android 可用')
    snapshot(page, 'web-disabled', 390)
    context.close()
    print('PASS note recommendation web cannot enable', flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for width, theme, scale in [(360, 'light', 1), (390, 'light', 1), (430, 'dark', 1.3), (1280, 'light', 1)]:
            native_run(browser, width, theme, scale)
        web_run(browser)
        browser.close()
