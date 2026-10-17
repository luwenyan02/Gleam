"""Real backup UI -> local relay -> mocked SMTP -> existing restore UI; no real mail."""
import base64
import http.client
import io
import json
import os
import sys
import tempfile
import threading
import zipfile
from pathlib import Path
from urllib.parse import urlsplit
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect
from test_acceptance_fixes import seed
from test_m3 import open_backup, do_restore

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / 'services/mail-backup'))
from server import Config, Relay, handler_for  # noqa: E402

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = ROOT / '.tmp/tests/e2e/email'
OUT.mkdir(parents=True, exist_ok=True)
TOKEN = 'fictional_test_token_' * 3
RECIPIENT = 'fictional.long.recipient@example.test'
PASSWORD = 'fictional-password-2026'


def run(browser, width):
    with tempfile.TemporaryDirectory(dir=OUT) as temporary:
        cfg = Config(TOKEN, 'fictional@qq.com', 'fictional-smtp-code', RECIPIENT, (), str(Path(temporary) / 'requests.db'))
        delivered = []
        def transport(_config, message=None):
            if message is not None:
                delivered.append(message)
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(Relay(cfg, transport)))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        context = browser.new_context(viewport={'width': width, 'height': 950}, service_workers='block')
        page = context.new_page()
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            drop_first = True
            def route_mail(route):
                nonlocal drop_first
                req = route.request
                if req.method == 'OPTIONS':
                    route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS'})
                    return
                data = req.post_data_json
                requests.append((req.url, data))
                connection = http.client.HTTPConnection(*server.server_address, timeout=5)
                try:
                    connection.request('POST', urlsplit(req.url).path, json.dumps(data), {
                        'Authorization': req.headers.get('authorization', ''), 'Content-Type': 'application/json',
                    })
                    response = connection.getresponse()
                    body = response.read()
                    if req.url.endswith('/v1/backup') and response.status == 200 and drop_first:
                        drop_first = False
                        route.abort('failed')  # SMTP accepted, but HTTP acknowledgement was lost.
                    else:
                        route.fulfill(status=response.status, body=body, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'})
                finally:
                    connection.close()
            page.route('https://mail.example.test/**', route_mail)
            page.goto(URL); page.locator('#fab').wait_for()
            seed(page, count=2)
            open_backup(page)
            email = page.locator('#email-backup')
            email.locator('[data-email="endpoint"]').fill('https://mail.example.test')
            email.locator('[data-email="token"]').fill('wrong-token')
            email.locator('[data-email="recipient"]').fill(RECIPIENT)
            email.locator('[data-email-act="test"]').click()
            expect(page.locator('#toast')).to_contain_text('访问令牌无效')
            email.locator('[data-email="token"]').fill(TOKEN)
            email.locator('[data-email-act="test"]').click()
            expect(page.locator('#toast')).to_contain_text('配置已保存')
            expect(page.locator('#toast')).not_to_have_class('show', timeout=6000)
            assert not delivered
            expect(email.locator('[data-email-act="send"]')).to_be_enabled()
            assert page.evaluate("sessionStorage.getItem('gleam-secret:cloud.email.token')") == TOKEN

            for scale in (1, 1.3):
                page.evaluate('s => document.documentElement.style.setProperty("--seed-type", String(s))', scale)
                email.scroll_into_view_if_needed()
                page.wait_for_timeout(350)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                for element in email.locator('input, button').all():
                    box = element.bounding_box()
                    assert box['width'] > 40 and box['x'] >= 0 and box['x'] + box['width'] <= width
                email.screenshot(path=str(OUT / f'config-{width}-{scale}.png'), animations='disabled')
            page.evaluate('document.documentElement.style.removeProperty("--seed-type")')
            email.locator('[data-email-act="send"]').click()
            page.locator('[data-email-close]').click()
            page.locator('#sheet.open').wait_for(state='detached')
            assert not delivered
            email.locator('[data-email-act="send"]').click()
            page.locator('[data-email-confirm]').click()
            expect(page.locator('.eb-result')).to_have_text('备份口令至少 8 位')
            page.locator('#email-p1').fill(PASSWORD)
            page.locator('#email-p2').fill('different')
            page.locator('[data-email-confirm]').click()
            expect(page.locator('.eb-result')).to_have_text('两次输入的口令不一致')
            assert not delivered
            page.locator('#email-p2').fill(PASSWORD)
            page.screenshot(path=str(OUT / f'confirm-{width}.png'), animations='disabled')
            page.locator('[data-email-confirm]').click()
            expect(page.locator('.eb-result')).to_contain_text('先检查收件箱')
            assert len(delivered) == 1
            page.locator('[data-email-confirm]').click()
            expect(page.locator('#toast')).to_contain_text('邮件服务器已接收')
            page.locator('#sheet.open').wait_for(state='detached')
            assert len(delivered) == 1, 'retry duplicated the email'
            sent = [data for url, data in requests if url.endswith('/v1/backup')]
            assert len(sent) == 2 and sent[0] == sent[1]
            expect(page.locator('[aria-label="备份历史"]')).to_contain_text('邮件服务器已接收')
            attachment, = delivered[0].iter_attachments()
            encrypted = attachment.get_payload(decode=True)
            assert encrypted == base64.b64decode(sent[0]['contentBase64'])
            # Inspect decrypted archive independently, including credential exclusion.
            decrypted = page.evaluate('''async ({content, password}) => {
              const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
              const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
              const key = await crypto.subtle.deriveKey({name:'PBKDF2',salt:bytes.slice(8,24),iterations:150000,hash:'SHA-256'}, material, {name:'AES-GCM',length:256}, false, ['decrypt']);
              const plain = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(24,36)}, key, bytes.slice(36)));
              return btoa(Array.from(plain, b => String.fromCharCode(b)).join(''));
            }''', {'content': sent[0]['contentBase64'], 'password': PASSWORD})
            with zipfile.ZipFile(io.BytesIO(base64.b64decode(decrypted))) as archive:
                raw = archive.read('data.json').decode()
                dump = json.loads(raw)
                assert len(dump['entries']) == 2
                assert TOKEN not in raw and PASSWORD not in raw and cfg.password not in raw
            backup = Path(temporary) / attachment.get_filename()
            backup.write_bytes(encrypted)
            do_restore(page, str(backup), password=PASSWORD)
            assert not errors, errors
            print(f'PASS email backup {width}: encrypted SMTP attachment, idempotent retry, restore', flush=True)
        finally:
            context.close(); server.shutdown(); server.server_close(); worker.join()


if __name__ == '__main__':
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for width in (360, 390, 430, 1280):
            run(browser, width)
        browser.close()
