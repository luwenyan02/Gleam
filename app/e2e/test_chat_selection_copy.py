"""普通聊天直发、用户原生选区与助手复制；合成 SSE，无真实服务。"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from test_life_ai import configure, open_life
from test_chat_resume import MOCK, enter

OUT=Path(__file__).parents[2]/'.tmp/tests/e2e/chat-selection-copy'
USER='虚构用户原话：周末去公园散步，想慢慢看看沿途的花。'
PARTIAL='**已经收到的片段**，还没有完成。'


def setup(browser,width,failed=False):
    context=browser.new_context(viewport={'width':width,'height':844},has_touch=width<600,reduced_motion='reduce',service_workers='block',permissions=['clipboard-read','clipboard-write'])
    context.route('https://**/*',lambda r:r.abort())
    page=context.new_page();page.add_init_script(MOCK)
    page.add_init_script('''(() => {const write=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async text=>{window.__copied=text;return write(text);};})();''')
    open_life(page);configure(page)
    if failed:
        page.evaluate('''async ([user,partial])=>{const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const tx=db.transaction('lifeDrafts','readwrite');tx.objectStore('lifeDrafts').put({key:'chat:selection',title:'',body:'',occurredAt:1,chatUpdatedAt:Date.now(),photos:[],existingPhotoRefs:[],aiExcluded:false,messages:[{role:'user',content:user}],chatReply:{messageIndex:0,regenerate:false,status:'failed',content:partial}});await new Promise(r=>tx.oncomplete=r);db.close();}''',[USER,PARTIAL])
    enter(page)
    return context,page


def request_started(page,count):
    page.wait_for_function('n=>window.__chatRequests.length===n || !!document.querySelector("#dialog-scrim.show")',arg=count)
    expect(page.locator('#dialog-scrim.show')).to_have_count(0)
    assert page.evaluate('window.__chatRequests.length')==count, '已启用普通聊天应直接发送'


def copy_selection(page):
    text=page.locator('.user .chat-message-text').first
    text.dblclick();selected=page.evaluate('getSelection().toString()')
    assert selected,'原生双击应可选择用户文字'
    page.keyboard.press('Control+C')
    assert page.evaluate('navigator.clipboard.readText()')==selected
    assert text.evaluate('''el=>{const s=getComputedStyle(el),e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});return s.userSelect==='text'&&s.webkitUserSelect==='text'&&el.dispatchEvent(e)&&!e.defaultPrevented;}'''), '保留浏览器选词和菜单，不拦截长按'
    return selected


def user_has_no_controls(page):
    expect(page.locator('.user button,.user [role="button"],.user .chat-message-actions,.user .chat-action-slot,.user textarea,.user input')).to_have_count(0)


def direct_stream_and_copy(browser,width):
    context,page=setup(browser,width)
    try:
        page.locator('#life-chat-input').fill(USER);page.locator('[data-life-chat-send]').click();request_started(page,1)
        page.evaluate("window.__chatRequests.at(-1).delta('第一段实时文字。')");expect(page.locator('.chat-streaming')).to_contain_text('第一段实时文字。')
        selected=copy_selection(page)
        page.evaluate("window.__selectedUser=document.querySelector('.user');window.__chatRequests.at(-1).delta('第二段实时文字。')")
        expect(page.locator('.chat-streaming')).to_contain_text('第二段实时文字。')
        assert page.evaluate('document.querySelector(".user")===window.__selectedUser')
        assert page.evaluate('getSelection().toString()')==selected,'逐片输出不能破坏用户选区'
        user_has_no_controls(page)
        page.evaluate('window.__chatRequests.at(-1).finish()');expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
        copy=page.locator('.assistant [data-chat-copy]').last;expect(copy).to_be_visible();copy.click()
        page.wait_for_function("window.__copied==='第一段实时文字。第二段实时文字。'")
        page.locator('[data-chat-regenerate]').click();request_started(page,2)
        page.evaluate('window.__chatRequests.at(-1).fail()');expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
        expect(page.locator('#life-chat-status')).not_to_be_empty();expect(page.locator('[data-life-chat-retry]')).to_be_visible();user_has_no_controls(page)
        page.locator('[data-life-chat-retry]').click();request_started(page,3)
        page.evaluate("window.__chatRequests.at(-1).delta('重试后的答案。');window.__chatRequests.at(-1).finish()")
        expect(page.locator('[data-life-chat-stop]')).to_be_hidden();expect(page.locator('.assistant')).to_have_count(1)
        page.locator('#life-chat-input').fill('第二条普通问题。');page.locator('[data-life-chat-send]').click();request_started(page,4)
        page.evaluate("window.__chatRequests.at(-1).delta('第二轮完整答案。');window.__chatRequests.at(-1).finish()")
        expect(page.locator('[data-life-chat-stop]')).to_be_hidden();expect(page.locator('.assistant [data-chat-copy]')).to_have_count(2);user_has_no_controls(page)
        OUT.mkdir(parents=True,exist_ok=True);page.locator('#toast.show').wait_for(state='hidden');page.screenshot(path=str(OUT/f'direct-complete-{width}.png'),animations='disabled')
    finally:context.close()


def interrupted_copy(browser,width):
    context,page=setup(browser,width,True)
    try:
        expect(page.locator('.chat-incomplete')).to_contain_text('已经收到的片段');expect(page.locator('#life-chat-status')).to_contain_text('未完成')
        copy=page.locator('.chat-incomplete [data-chat-copy]');expect(copy).to_have_count(1);copy.click()
        page.wait_for_function('text=>window.__copied===text',arg=PARTIAL)
        expect(page.locator('[data-life-chat-retry]')).to_be_visible();user_has_no_controls(page)
        OUT.mkdir(parents=True,exist_ok=True);page.locator('#toast.show').wait_for(state='hidden');page.screenshot(path=str(OUT/f'interrupted-copy-{width}.png'),animations='disabled')
    finally:context.close()


def failed_user_is_plain_text(browser,width):
    context,page=setup(browser,width,True)
    try:
        user_has_no_controls(page);expect(page.locator('[data-life-chat-retry]')).to_be_visible();copy_selection(page)
    finally:context.close()


if __name__=='__main__':
    widths=[int(v) for v in os.environ.get('GLEAM_SELECTION_WIDTHS','360,390,430,1280').split(',')];failures=[]
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for width in widths:
            for case in (direct_stream_and_copy,interrupted_copy,failed_user_is_plain_text):
                try:case(browser,width);print('PASS',case.__name__,width,flush=True)
                except Exception as error:failures.append((case.__name__,width,str(error)));print('FAIL',case.__name__,width,str(error),flush=True)
        browser.close()
    assert not failures,failures
