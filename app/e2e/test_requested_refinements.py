"""用户四项反馈的回归；所有账目、账户与对象均为虚构数据。"""
import os
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright, expect
from test_acceptance_fixes import seed, SHOTS

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')

def fixture(page):
    seed(page, amount=4865025)
    page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction(['accounts'],'readwrite');
      tx.objectStore('accounts').put({id:2,name:'演示银行卡',group:'debit',balance:100000,hidden:false,countInNetWorth:true,sortOrder:2,createdAt:1,updatedAt:1});
      tx.objectStore('accounts').put({id:3,name:'演示小林',group:'receivable',balance:0,hidden:false,countInNetWorth:true,sortOrder:3,createdAt:1,updatedAt:1});
      await new Promise(r=>tx.oncomplete=r);db.close();
    }''')

def home(page, width):
    fixture(page)
    card = page.locator('#hm-month')
    expect(card).to_be_visible()
    expect(page.locator('#m-balance')).to_have_text('-48,650.25')
    assert card.locator('.mc-unit').inner_text() == '单位：元'
    assert 'monospace' not in page.locator('#m-spend').evaluate('e=>getComputedStyle(e).fontFamily')
    values = page.locator('.mc-row > div').evaluate_all('els=>els.map(e=>e.getBoundingClientRect().width)')
    assert max(values)-min(values)<2
    assert page.locator('.mc-row .num').evaluate_all('els=>els.every(e=>e.scrollWidth<=e.clientWidth+1)')
    page.screenshot(path=str(SHOTS/f'refined-home-{width}.png'))

def loan(page, width):
    fixture(page);page.locator('#fab').click();page.locator('#seg [data-type="loan"]').click()
    page.locator('#loan-who').click();page.locator('.picker-item',has_text='演示小林').click()
    page.locator('.picker-mask').wait_for(state='detached')
    for kind, first, second in [('lend','loan-acct','loan-who'),('repay','loan-acct','loan-who'),('borrow','loan-who','loan-acct'),('collect','loan-who','loan-acct')]:
        page.locator(f'[data-kind="{kind}"]').click()
        assert page.locator('#loan-flow > button').evaluate_all('els=>els.map(e=>e.id)') == [first,second]
        assert page.locator('#loan-arrow').is_visible()
        assert page.locator('#loan-who b').inner_text()=='演示小林'
        assert page.locator(f'#{first}').bounding_box()['x']<page.locator(f'#{second}').bounding_box()['x']
    page.locator('[data-kind="lend"]').click()
    page.screenshot(path=str(SHOTS/f'refined-loan-{width}.png'))

def swap(page, width):
    fixture(page);page.locator('#fab').click();page.locator('#seg [data-type="transfer"]').click()
    page.locator('#t-to').click();page.locator('.picker-item',has_text='演示银行卡').click()
    page.locator('.picker-mask').wait_for(state='detached')
    page.locator('#keypad [data-k="8"]').click();page.locator('#note').fill('交换保留备注');page.locator('#note').blur()
    before=[page.locator(f'#t-{side} b').inner_text() for side in ('from','to')]
    page.get_by_role('button',name='交换转出与转入账户',exact=True).click()
    assert [page.locator(f'#t-{side} b').inner_text() for side in ('from','to')]==before[::-1]
    assert page.locator('#amt').inner_text()=='8' and page.locator('#note').input_value()=='交换保留备注'
    page.locator('#t-swap').focus();page.keyboard.press('Enter')
    assert [page.locator(f'#t-{side} b').inner_text() for side in ('from','to')]==before
    page.screenshot(path=str(SHOTS/f'refined-transfer-{width}.png'))
    page.locator('#t-swap').click();page.locator('#keypad [data-k="save"]').click()
    page.locator('#sheet.open').wait_for(state='detached')
    row=page.evaluate('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});const tx=db.transaction('entries');return await new Promise(r=>{const q=tx.objectStore('entries').getAll();q.onsuccess=()=>{db.close();r(q.result.find(e=>e.type==='transfer'))}})}''')
    assert row['fromAccountId']==2 and row['toAccountId']==1 and row['amount']==800

def models(page, width):
    page.clock.set_fixed_time(datetime(2026,10,22,12,tzinfo=timezone.utc))
    calls=[]
    page.route('https://**/*',lambda route:route.abort()) # 本测试禁止真实 AI 请求
    def chat(route):
        calls.append(route.request.post_data_json)
        route.fulfill(json={'choices':[{'message':{'content':'OK'}}]})
    page.route('**/chat/completions',chat)
    page.evaluate('''async()=>{
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction('settings','readwrite'),s=tx.objectStore('settings');
      s.put({key:'ai.baseUrl',value:'https://dashscope.aliyuncs.com/compatible-mode/v1'});
      s.put({key:'ai.model',value:'qwen-vl-plus'});
      s.put({key:'ai.recentModels',value:['wrong-unscoped-model']});
      s.put({key:'ai.modelCatalogCache',value:{baseUrl:'https://api.deepseek.com',ids:['wrong-platform-model']}});
      await new Promise(r=>tx.oncomplete=r);db.close();
      sessionStorage.setItem('gleam-secret:ai.apiKey','fictional-test-key');
    }''')
    page.locator('.tab[data-page="page-mine"]').click();page.get_by_role('button',name='应用设置',exact=True).click()
    page.locator('#ai-model').wait_for()
    assert page.locator('#ai-model').input_value()=='qwen-vl-plus', '升级不得覆盖旧配置'
    page.locator('#ai-model-pick').click();page.locator('.picker-panel.open').wait_for()
    page.wait_for_timeout(300) # 完成弹层入场再核对实际排版
    labels=page.locator('.picker-item-label').all_inner_texts()
    assert len(labels)<=11 and 'qwen3.8-max-0902' in labels and 'deepseek-v4.1-flash-1017' in labels
    assert not set(labels).intersection(['qwen3.7-plus','deepseek-v4-pro-0813','deepseek-v4-flash-0731'])
    assert 'wrong-platform-model' not in labels and 'wrong-unscoped-model' not in labels
    assert page.locator('.picker-item-label').evaluate_all('els=>els.every(e=>e.scrollWidth<=e.clientWidth+1)'), '完整展示模型名'
    assert page.locator('.picker-item').evaluate_all('els=>els.every(e=>e.getBoundingClientRect().right<=innerWidth+1)'), '模型选项不超出视口'
    page.screenshot(path=str(SHOTS/f'refined-models-{width}.png'))
    page.locator('.picker-item[data-value="deepseek-v4.1-flash-1017"]').click();page.locator('.picker-mask').wait_for(state='detached')
    expect(page.locator('#ai-model')).to_have_value('deepseek-v4.1-flash-1017')
    expect(page.locator('#ai-model-capability')).to_have_text('图片、文字')
    page.locator('[data-act="ai-test"]').click();page.wait_for_function('document.querySelector("[data-act=ai-test]").textContent==="测试连接"')
    assert calls[-1]['model']=='deepseek-v4.1-flash-1017'
    page.locator('#ai-model-pick').click();page.locator('.picker-panel.open').wait_for()
    page.locator('.picker-item[data-value="qwen3.8-flash"]').click();page.locator('.picker-mask').wait_for(state='detached')
    page.wait_for_function('document.querySelector("#ai-model").value==="qwen3.8-flash"')
    page.locator('[data-act="ai-test"]').click();page.wait_for_function('document.querySelector("[data-act=ai-test]").textContent==="测试连接"')
    assert calls[-1]['enable_thinking'] is False and calls[-1]['temperature']==0
    page.locator('#ai-provider').click();page.locator('.picker-item[data-value="openai"]').click();page.locator('.picker-mask').wait_for(state='detached')
    page.locator('#ai-model-pick').click();page.locator('.picker-item[data-value="gpt-6-astra"]').click();page.locator('.picker-mask').wait_for(state='detached')
    page.wait_for_function('document.querySelector("#ai-model").value==="gpt-6-astra"')
    page.locator('[data-act="ai-test"]').click();page.wait_for_function('document.querySelector("[data-act=ai-test]").textContent==="测试连接"')
    assert calls[-1]['model']=='gpt-6-astra' and 'temperature' not in calls[-1]
    page.route('**/models',lambda route:route.fulfill(json={'data':[{'id':'gpt-6-astra'}]+[{'id':f'api-extra-{i}'} for i in range(20)]}))
    page.locator('[data-act="ai-models"]').click()
    page.wait_for_function('document.querySelector("[data-act=ai-models]").textContent==="获取模型列表"')
    page.locator('#ai-model-pick').click();page.locator('.picker-panel.open').wait_for();page.wait_for_timeout(250)
    assert page.locator('.picker-item').count()>20, '接口返回候选不应截断到10项'
    assert page.locator('#ai-model').input_value()=='gpt-6-astra'
    page.get_by_role('textbox',name='搜索选项').fill('api-extra-19')
    expect(page.locator('.picker-item[data-value="api-extra-19"]')).to_be_visible()
    page.locator('.picker-item[data-value="api-extra-19"]').click();page.locator('.picker-mask').wait_for(state='detached')
    expect(page.locator('#ai-model')).to_have_value('api-extra-19')
    page.locator('#ai-model-pick').click();page.locator('.picker-item[data-value="gpt-6-astra"]').click();page.locator('.picker-mask').wait_for(state='detached')
    page.locator('#ai-model-pick').click();page.locator('.picker-panel.open').wait_for()
    # The slide-in class precedes modal focus setup; Escape must target the ready picker.
    expect(page.get_by_role('textbox',name='搜索选项')).to_be_focused()
    page.keyboard.press('Escape');page.locator('.picker-mask').wait_for(state='detached')
    page.locator('#ai-provider').click();page.locator('.picker-item[data-value="dashscope"]').click();page.locator('.picker-mask').wait_for(state='detached')
    page.locator('#ai-model-pick').click();page.locator('.picker-panel.open').wait_for()
    assert not any('api-extra-' in label for label in page.locator('.picker-item-label').all_inner_texts()), '拉取缓存不能串平台'
    expect(page.get_by_role('textbox',name='搜索选项')).to_be_focused()
    page.keyboard.press('Escape');page.locator('.picker-mask').wait_for(state='detached')
    catalog_models(page, width, calls)

def catalog_models(page, width, calls):
    cases=[('openai','gpt-6.1-sol','图片、文字'),
           ('deepseek','deepseek-flash','图片、文字'),
           ('siliconflow','deepseek-ai/DeepSeek-V4.1-Flash','图片、文字'),
           ('moonshot','kimi-k3','图片、文字'),
           ('zhipu','glm-5.3-flashx','图片、文字'),
           ('zhipu','glm-5.3','文字'),
           ('moonshot','kimi-k2.7-code','图片、文字'),
           ('moonshot','kimi-k2.7-code-highspeed','图片、文字'),
           ('deepseek','deepseek-v4-flash','图片、文字')]
    for provider,model,capability in cases:
        saved=page.locator('#ai-model').input_value()
        page.locator('#ai-provider').click();page.locator(f'.picker-item[data-value="{provider}"]').click();page.locator('.picker-mask').wait_for(state='detached')
        expect(page.locator('#ai-model')).to_have_value(saved)
        page.locator('#ai-model-pick').click();page.locator('.picker-panel.open').wait_for()
        groups=page.locator('.picker-group-title').all_inner_texts()
        assert '推荐模型' in groups and '兼容旧版' in groups, (provider,groups)
        assert page.locator('.picker-item-label').evaluate_all('els=>els.every(e=>e.scrollWidth<=e.clientWidth+1)')
        assert page.locator('.picker-item').evaluate_all('els=>els.every(e=>e.getBoundingClientRect().right<=innerWidth+1)')
        if width==390:
            page.locator('#toast.show').wait_for(state='hidden')
            page.wait_for_timeout(250)
            page.screenshot(path=str(SHOTS/f'model-catalog-{provider}-{model.split("/")[-1]}.png'))
        page.get_by_role('textbox',name='搜索选项').fill(model)
        page.locator(f'.picker-item[data-value="{model}"]').click();page.locator('.picker-mask').wait_for(state='detached')
        expect(page.locator('#ai-model')).to_have_value(model)
        expect(page.locator('#ai-model-capability')).to_have_text(capability)
        page.locator('[data-act="ai-test"]').click();page.wait_for_function('document.querySelector("[data-act=ai-test]").textContent==="测试连接"')
        payload=calls[-1]
        assert payload['model']==model, payload
        if provider in ('openai','moonshot','zhipu'):
            assert 'temperature' not in payload, payload
        if provider=='deepseek':
            assert payload['thinking']=={'type':'disabled'}, payload
        if provider=='zhipu':
            assert payload.get('thinking',{}).get('type')!='disabled', payload

if __name__=='__main__':
    failed=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        for fn in (home,loan,swap,models):
            for width in (360,390,430,1024):
                if os.environ.get('GLEAM_E2E_CASE') and os.environ['GLEAM_E2E_CASE']!=fn.__name__:continue
                ctx=browser.new_context(viewport={'width':width,'height':844},service_workers='block')
                page=ctx.new_page();page.set_default_timeout(5000)
                try:
                    page.goto(URL);page.wait_for_load_state('networkidle');page.wait_for_selector('#fab');fn(page,width);print('PASS',fn.__name__,width,flush=True)
                except Exception as e:
                    print('FAIL',fn.__name__,width,str(e),flush=True);failed.append((fn.__name__,width));page.screenshot(path=str(SHOTS/f'refinement-{fn.__name__}-{width}-fail.png'))
                finally:ctx.close()
        browser.close()
    raise SystemExit(1 if failed else 0)
