"""Provider round trips with synthetic keys and intercepted connection tests."""
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
from test_ai_key_settings import open_settings, stored, summary
from test_browser_usability import assert_usable

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4617/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/ai-provider-profiles'


def choose(page, provider, label):
    page.locator('#ai-provider').click()
    page.locator(f'.picker-item[data-value="{provider}"]').click()
    expect(page.locator('#ai-provider')).to_have_text(label)
    expect(page.locator('#ai-provider')).to_be_enabled()


def configure(page, base, model, key):
    field = page.locator('#ai-base')
    field.fill(base); field.press('Tab')
    expect(field).to_have_value(base)
    page.locator('#ai-model-pick').click()
    page.locator('.picker-item[data-value="__custom__"]').click()
    field = page.locator('#ai-model')
    field.fill(model); field.press('Tab')
    expect(page.locator('#ai-model-pick')).to_have_text(model)
    field = page.locator('#ai-key')
    field.fill(key); field.press('Tab')
    expect(field).to_have_attribute('placeholder', summary(key))


def run(page, width):
    errors, unexpected, requests = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    origin = urlsplit(URL).netloc
    reject = False

    def network(route):
        if urlsplit(route.request.url).netloc == origin:
            route.continue_()
        elif route.request.url.startswith('https://fixture-'):
            requests.append((route.request.url, route.request.post_data_json, route.request.headers.get('authorization')))
            route.fulfill(status=401 if reject else 200, json={'choices': [{'message': {'content': 'OK'}}]})
        else:
            unexpected.append(route.request.url); route.abort()

    page.route('**/*', network)
    page.goto(URL); page.locator('#fab').wait_for(); open_settings(page)
    choose(page, 'dashscope', '阿里百炼')
    configure(page, 'https://fixture-bailian.invalid/v1', 'fixture-bailian-model', 'fixture-bailian-private-key')
    page.locator('[data-act="ai-test"]').click()
    expect(page.locator('#toast')).to_contain_text('已保存此平台配置')
    expect(page.locator('#ai-provider')).to_be_enabled()
    assert requests[-1] == ('https://fixture-bailian.invalid/v1/chat/completions',
                            {'model': 'fixture-bailian-model', 'temperature': 0,
                             'messages': [{'role': 'user', 'content': '只回复两个字符：OK'}]},
                            'Bearer fixture-bailian-private-key')
    choose(page, 'openai', 'OpenAI')
    assert stored(page) is None
    expect(page.locator('#ai-model-pick')).not_to_have_text('fixture-bailian-model')
    configure(page, 'https://fixture-openai.invalid/v1', 'fixture-openai-model', 'fixture-openai-private-key')
    page.locator('[data-act="ai-test"]').click()
    expect(page.locator('#toast')).to_contain_text('已保存此平台配置')
    expect(page.locator('#ai-provider')).to_be_enabled()
    choose(page, 'dashscope', '阿里百炼')
    expect(page.locator('#ai-base')).to_have_value('https://fixture-bailian.invalid/v1')
    expect(page.locator('#ai-model-pick')).to_have_text('fixture-bailian-model')
    expect(page.locator('#ai-key')).to_have_attribute('placeholder', summary('fixture-bailian-private-key'))
    assert stored(page) == 'fixture-bailian-private-key'
    # A successful edit replaces the earlier working profile; a failed edit does not.
    configure(page, 'https://fixture-bailian-new.invalid/v1', 'fixture-bailian-new-model', 'fixture-bailian-new-private-key')
    page.locator('[data-act="ai-test"]').click()
    expect(page.locator('#ai-provider')).to_be_enabled()
    reject = True
    configure(page, 'https://fixture-rejected.invalid/v1', 'fixture-rejected-model', 'fixture-rejected-private-key')
    page.locator('[data-act="ai-test"]').click()
    expect(page.locator('#toast')).to_contain_text('配置不可用')
    expect(page.locator('#ai-provider')).to_be_enabled()
    choose(page, 'openai', 'OpenAI'); choose(page, 'dashscope', '阿里百炼')
    expect(page.locator('#ai-base')).to_have_value('https://fixture-bailian-new.invalid/v1')
    expect(page.locator('#ai-model-pick')).to_have_text('fixture-bailian-new-model')
    assert stored(page) == 'fixture-bailian-new-private-key'
    page.reload(); page.locator('#fab').wait_for(); open_settings(page)
    expect(page.locator('#ai-provider')).to_have_text('阿里百炼')
    choose(page, 'openai', 'OpenAI')
    expect(page.locator('#ai-base')).to_have_value('https://fixture-openai.invalid/v1')
    expect(page.locator('#ai-model-pick')).to_have_text('fixture-openai-model')
    expect(page.locator('#ai-key')).to_have_value('')
    assert stored(page) == 'fixture-openai-private-key'
    html = page.locator('#sp-ai-settings').inner_html()
    assert 'fixture-openai-private-key' not in html
    assert 'fixture-bailian-new-private-key' not in html
    rows = page.evaluate("""async () => {
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction('settings');const rows=await new Promise(r=>{const q=tx.objectStore('settings').getAll();q.onsuccess=()=>r(q.result)});db.close();return JSON.stringify(rows);
    }""")
    assert 'fixture-openai-private-key' not in rows
    block = page.locator('#sp-ai-settings section[aria-label="AI 记账"]')
    block.scroll_into_view_if_needed(); assert_usable(page, '#sp-ai-settings section[aria-label="AI 记账"]')
    page.screenshot(path=str(OUT / f'profile-restored-{width}.png'), animations='disabled')
    if width == 400:
        # Shared IndexedDB and isolated sessionStorage: an old form in a second
        # tab must reject a key typed for its formerly selected provider.
        other = page.context.new_page()
        other.goto(URL); other.locator('#fab').wait_for()
        other.evaluate("""() => {
          sessionStorage.setItem('gleam-secret:ai.apiKey', 'fixture-other-tab-openai-key');
          sessionStorage.setItem('gleam-secret:ai.activeCredential', JSON.stringify({providerId:'openai',baseUrl:'https://fixture-openai.invalid/v1',apiKey:'fixture-other-tab-openai-key'}));
        }""")
        open_settings(other)
        expect(other.locator('#ai-provider')).to_have_text('OpenAI')
        choose(page, 'dashscope', '阿里百炼')
        expect(other.locator('#ai-provider')).to_have_text('OpenAI')
        before = len(requests)
        other.locator('#ai-key').fill('fixture-typed-for-stale-openai-form')
        other.locator('#ai-key').press('Tab')
        expect(other.locator('#toast')).to_contain_text('API Key 保存失败')
        expect(other.locator('#ai-provider')).to_have_text('阿里百炼')
        other.locator('[data-act="ai-test"]').click()
        expect(other.locator('#toast')).to_contain_text('API Key 保存失败')
        assert len(requests) == before
        assert stored(other) == 'fixture-other-tab-openai-key'
        other.close()
    assert not errors, errors
    assert not unexpected, unexpected


def initialization_retry(browser):
    context = browser.new_context(viewport={'width': 400, 'height': 890}, has_touch=True, is_mobile=True, service_workers='block')
    page = context.new_page()
    page.goto(URL); page.locator('#fab').wait_for()
    page.evaluate("""async () => {
      sessionStorage.setItem('gleam-secret:ai.apiKey','fixture-legacy-key-kept-on-failure');
      const db=await new Promise(r=>{const q=indexedDB.open('GleamDB');q.onsuccess=()=>r(q.result)});
      const tx=db.transaction('settings','readwrite'), store=tx.objectStore('settings');
      for(const [key,value] of [['ai.baseUrl','https://fixture-legacy.invalid/v1'],['ai.model','fixture-legacy-model']]) store.put({key,value,updatedAt:1});
      await new Promise(r=>tx.oncomplete=r); db.close();
      const set=Storage.prototype.setItem;
      window.__blockCredentialSave=true;
      Storage.prototype.setItem=function(key,value) {
        if(window.__blockCredentialSave && key==='gleam-secret:ai.activeCredential') throw new Error('fixture-storage-failure');
        return set.call(this,key,value);
      };
    }""")
    page.locator('[data-page="page-mine"]').click()
    page.locator('#page-mine [data-sub="sp-ai-settings"]').click()
    expect(page.locator('#sp-ai-settings [role="alert"]')).to_contain_text('原设置未清除')
    expect(page.locator('#sp-ai-settings [data-act="ai-reload"]')).to_be_visible()
    assert stored(page) == 'fixture-legacy-key-kept-on-failure'
    page.evaluate('window.__blockCredentialSave=false')
    page.locator('[data-act="ai-reload"]').click()
    expect(page.locator('#ai-base')).to_have_value('https://fixture-legacy.invalid/v1')
    expect(page.locator('#ai-model')).to_have_value('fixture-legacy-model')
    expect(page.locator('#ai-key')).to_have_attribute('placeholder', summary('fixture-legacy-key-kept-on-failure'))
    context.close()
    print('PASS AI profile initialization failure and retry', flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in (360, 390, 400, 430, 1280):
            context = browser.new_context(viewport={'width': width, 'height': 890 if width == 400 else 844},
                                          device_scale_factor=3 if width == 400 else 1,
                                          is_mobile=width < 500, has_touch=width < 500,
                                          service_workers='block', reduced_motion='reduce')
            run(context.new_page(), width); context.close()
            print(f'PASS AI provider profiles {width}', flush=True)
        initialization_retry(browser)
        browser.close()
