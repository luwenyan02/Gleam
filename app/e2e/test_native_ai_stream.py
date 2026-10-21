"""Production native pull adapter with incremental synthetic wire data and cancellation."""
from playwright.sync_api import sync_playwright, expect
from test_life_ai import configure, open_life
from test_native_live_voice import MOCK

WIRE = r'''(() => {
 const original=window.fetch.bind(window);window.__wireRequests=[];
 window.fetch=(url,init)=>String(url).startsWith('https://life-ai.invalid/')?Promise.reject(Error('BUFFERED_FETCH_FORBIDDEN')):original(url,init);
 window.__nativeAiWireFetch=async(url,init)=>{
  const request={signal:init.signal,payload:JSON.parse(init.body)};window.__wireRequests.push(request);
  const stream=new ReadableStream({start(controller){
   request.delta=text=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n'));
   request.finish=()=>{controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();};
   init.signal.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')),{once:true});
  }});
  return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
 };
})();'''


if __name__ == '__main__':
    with sync_playwright() as p:
        browser=p.chromium.launch()
        context=browser.new_context(viewport={'width':390,'height':844},service_workers='block',reduced_motion='reduce')
        context.route('https://**/*',lambda route:route.abort())
        page=context.new_page();page.add_init_script(MOCK);page.add_init_script(WIRE)
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        open_life(page);configure(page);page.locator('[data-life-chat]').click()
        page.locator('#life-chat-input').fill('虚构问题：分段回复。');page.locator('[data-life-chat-send]').click()
        page.wait_for_function('window.__wireRequests.length===1')
        expect(page.locator('#dialog-scrim.show')).to_have_count(0)
        page.evaluate("window.__wireRequests[0].delta('第一段已经到达。')")
        expect(page.locator('.chat-streaming')).to_contain_text('第一段已经到达。')
        expect(page.locator('[data-life-chat-stop]')).to_be_visible()
        assert page.evaluate('window.__aiStreamCalls.some(call=>call.method==="read")')
        assert page.evaluate('window.__wireRequests[0].payload.stream') is True
        page.evaluate("window.__wireRequests[0].delta('第二段随后到达。')")
        expect(page.locator('.chat-streaming')).to_contain_text('第二段随后到达。')
        page.evaluate('window.__wireRequests[0].finish()')
        expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
        expect(page.locator('.chat-incomplete,.life-chat-failed')).to_have_count(0)
        expect(page.locator('.assistant [data-chat-copy]')).to_have_count(1)
        page.locator('#life-chat-input').fill('虚构问题：随后停止。');page.locator('[data-life-chat-send]').click()
        page.wait_for_function('window.__wireRequests.length===2')
        page.evaluate("window.__wireRequests[1].delta('只保留这一段。')")
        expect(page.locator('.chat-streaming')).to_contain_text('只保留这一段。')
        page.locator('[data-life-chat-stop]').click()
        expect(page.locator('[data-life-chat-stop]')).to_be_hidden()
        assert page.evaluate('window.__wireRequests[1].signal.aborted')
        expect(page.locator('.chat-incomplete')).to_contain_text('只保留这一段。')
        assert not errors,errors
        context.close();browser.close()
        print('PASS native AI pull stream before completion, faithful bytes and cancellation')
