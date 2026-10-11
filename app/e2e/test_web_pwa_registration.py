"""Built PWA registration: real browser worker, synthetic native bridge, loopback only."""
import hashlib
import re
import os
import shutil
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
from test_short_voice import MOCK_NATIVE

APP = Path(__file__).parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def wait_active_worker(page):
    # Playwright wait_for_function does not repoll an async predicate returning
    # false. Await each browser query explicitly and retry in bounded Python time.
    end = time.monotonic() + 30
    while time.monotonic() < end:
        if page.evaluate("""async()=>{
            const r=await navigator.serviceWorker.getRegistration();
            return r?.active?.state==='activated' && !r.waiting && !r.installing
                && r.active===navigator.serviceWorker.controller
                && navigator.serviceWorker.controller.scriptURL.endsWith('/sw.js');
        }"""):
            return
        time.sleep(0.1)
    raise AssertionError('Current browser worker did not become active and controlling')


def run():
    dist = APP / 'dist'
    html = (dist / 'index.html').read_text()
    worker = (dist / 'sw.js').read_text()
    assert 'registerSW.js' not in html and 'serviceWorker.register' not in html
    assert 'self.skipWaiting()' in worker and 'clientsClaim()' in worker
    assert (dist / 'manifest.webmanifest').is_file()
    # Test-only revisions modify one HTML meta marker and its matching Workbox
    # index revision. Built application/helper/Workbox runtime bytes stay unchanged.
    revisions = {}
    for revision in ('one', 'two'):
        marked = html.replace('<head>', '<head><meta name="gleam-pwa-test-revision" content="' + revision + '">', 1)
        digest = hashlib.md5(marked.encode()).hexdigest()
        changed, count = re.subn(r'(url:"index.html",revision:")[0-9a-f]+(")',
                                lambda m: m.group(1) + digest + m.group(2), worker)
        assert count == 1, 'Expected exactly one generated Workbox index revision'
        revisions[revision] = (marked.encode(), changed.encode())
    state = {'revision': 'one'}
    class RevisionHandler(QuietHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(dist), **kwargs)
        def do_GET(self):
            path = urlsplit(self.path).path
            if path in ('/', '/index.html', '/sw.js'):
                data = revisions[state['revision']][1 if path == '/sw.js' else 0]
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript' if path == '/sw.js' else 'text/html')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                super().do_GET()
    server = ThreadingHTTPServer(('127.0.0.1', 0), RevisionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as playwright:
            executable = os.environ.get('GLEAM_E2E_BROWSER_EXECUTABLE') or shutil.which('chromium')
            browser = playwright.chromium.launch(executable_path=executable, args=[
                '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'])
            try:
                for native in (False, True):
                    context = browser.new_context(service_workers='allow')
                    external, errors = [], []
                    def local_only(route):
                        if urlsplit(route.request.url).netloc != urlsplit(origin).netloc:
                            external.append(route.request.url)
                            route.abort()
                        else:
                            route.continue_()
                    context.route('**/*', local_only)
                    context.add_init_script("""(() => {
                        window.__pwaRegisterCalls=[];
                        const register=ServiceWorkerContainer.prototype.register;
                        ServiceWorkerContainer.prototype.register=function(url,options) {
                            window.__pwaRegisterCalls.push(new URL(String(url),location.href).href);
                            return register.call(this,url,options);
                        };
                    })()""")
                    if native:
                        context.add_init_script(MOCK_NATIVE)
                    state['revision'] = 'one'
                    page = context.new_page()
                    navigations = []
                    page.on('framenavigated', lambda frame: navigations.append(frame.url) if frame == page.main_frame else None)
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(origin + '/')
                    page.locator('#fab').wait_for()
                    if native:
                        for navigation in range(2):
                            page.wait_for_timeout(2000)
                            assert page.evaluate('window.__pwaRegisterCalls') == []
                            assert page.evaluate('navigator.serviceWorker.controller === null')
                            assert page.evaluate('async()=> (await navigator.serviceWorker.getRegistrations()).length') == 0
                            if navigation == 0:
                                page.reload()
                                page.locator('#fab').wait_for()
                    else:
                        wait_active_worker(page)
                        assert page.evaluate('window.__pwaRegisterCalls') == [origin + '/sw.js']
                        assert page.locator('meta[name="gleam-pwa-test-revision"]').get_attribute('content') == 'one'
                        page.evaluate("localStorage.setItem('pwa-update-synthetic','retained')")
                        before_update = len(navigations)
                        state['revision'] = 'two'
                        # Ask the real registration to check for the second SW bytes. No
                        # explicit navigation: the built autoUpdate callback must reload.
                        page.evaluate("void navigator.serviceWorker.getRegistration().then(r=>r.update())")
                        page.wait_for_function("document.querySelector('meta[name=gleam-pwa-test-revision]')?.content==='two'")
                        page.locator('#fab').wait_for()
                        assert len(navigations) > before_update, 'Browser autoUpdate did not reload the app'
                        assert page.evaluate("localStorage.getItem('pwa-update-synthetic')") == 'retained'
                        wait_active_worker(page)
                        context.set_offline(True)
                        page.reload()
                        page.locator('#fab').wait_for()
                        assert page.evaluate('navigator.serviceWorker.controller.scriptURL') == origin + '/sw.js'
                        assert page.locator('meta[name="gleam-pwa-test-revision"]').get_attribute('content') == 'two'
                    assert not external, external
                    assert not errors, errors
                    context.close()
                    print('PASS built PWA ' + ('synthetic native stays unregistered across reload' if native else 'web activates, auto-updates/reloads to revision two, then reloads offline'), flush=True)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    run()
