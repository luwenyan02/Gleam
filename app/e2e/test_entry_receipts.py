"""普通账单凭证闭环，全部图片为 canvas 合成的虚构测试素材。"""
import base64
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright
from test_acceptance_fixes import seed
from test_save_atomic import fail_once

URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
OUT = Path(__file__).parents[2] / '.tmp/tests/e2e/receipts'


def image(page, name, color):
    data = page.evaluate('''color => {
      const c = document.createElement('canvas'); c.width = 400; c.height = 240;
      const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 400, 240);
      x.fillStyle = '#ffffff'; x.font = '28px sans-serif'; x.fillText('TEST RECEIPT', 36, 110);
      return c.toDataURL('image/png').split(',')[1];
    }''', color)
    return {'name': name, 'mimeType': 'image/png', 'buffer': base64.b64decode(data)}


def counts(page):
    return page.evaluate('''async () => {
      const db = await new Promise(r => { const q = indexedDB.open('GleamDB'); q.onsuccess = () => r(q.result); });
      const names = ['entries', 'entryAttachments', 'attachments'];
      const tx = db.transaction(names);
      const result = await Promise.all(names.map(n => new Promise(r => {
        const q = tx.objectStore(n).getAll(); q.onsuccess = () => r(q.result.map(row => ({id: row.id, name: row.name, sortOrder: row.sortOrder, attachmentId: row.attachmentId})));
      })));
      db.close(); return result;
    }''')


def select(page, files):
    page.locator('#receipt-editor input[type=file]').set_input_files(files)
    page.wait_for_function("!document.querySelector('[data-receipt-add]').disabled")


def run(page, width):
    page.goto(URL); page.wait_for_selector('#fab'); seed(page, count=0)
    first, second = image(page, '虚构红.png', '#b34a36'), image(page, '虚构蓝.png', '#316a92')
    page.locator('#fab').click(); page.locator('[data-act="toggle-advanced"]').click()
    select(page, [first, second])
    assert len(counts(page)[2]) == 0, '草稿不能提前写入 Blob'
    page.locator('[data-before="1"]').click()
    page.locator('[data-preview="0"]').click()
    page.locator('.receipt-preview').wait_for()
    assert page.locator('.receipt-preview img').get_attribute('alt') == '虚构蓝.png'
    page.wait_for_function("document.querySelector('.receipt-preview')?.contains(document.activeElement)")
    page.keyboard.press('Escape'); page.locator('.receipt-preview').wait_for(state='detached')
    page.locator('[data-replace="1"]').click()
    select(page, [image(page, '虚构绿.png', '#36704b')])
    assert page.locator('.receipt-item').count() == 2
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    assert page.locator('.receipt-actions button').evaluate_all('(es) => es.every(e => e.getBoundingClientRect().height >= 44 && e.getBoundingClientRect().width >= 44)')
    page.locator('#receipt-editor').scroll_into_view_if_needed(); page.wait_for_timeout(350)
    page.screenshot(path=str(OUT / f'editor-{width}.png'), animations='disabled')
    page.locator('#keypad [data-k="1"]').click()
    fail_once(page, 'entryAttachments')
    page.locator('#keypad [data-k="save"]').click()
    page.wait_for_function("document.querySelector('#toast')?.textContent.includes('虚构写入故障')")
    assert [len(x) for x in counts(page)] == [0, 0, 0]
    page.locator('#keypad [data-k="save"]').click(); page.locator('#sheet.open').wait_for(state='detached')
    rows = counts(page)
    assert [len(x) for x in rows] == [1, 2, 2]
    by_id = {row['id']: row['name'] for row in rows[2]}
    assert [by_id[row['attachmentId']] for row in sorted(rows[1], key=lambda x: x['sortOrder'])] == ['虚构蓝.png', '虚构绿.png']
    page.reload(); page.wait_for_selector('#fab')
    page.locator('[data-entry]').first.click()
    page.locator('#sp-entry-view.open').wait_for()
    assert page.locator('[data-view-receipt]').count() == 2
    page.screenshot(path=str(OUT / f'detail-{width}.png'), animations='disabled')
    page.locator('[data-view-action="edit"]').click()
    page.locator('[data-remove="0"]').click(); page.locator('#sheet-close').click()
    page.locator('#sheet.open').wait_for(state='detached')
    assert len(counts(page)[1]) == 2, '取消不能改变关系'
    page.locator('[data-view-action="edit"]').click()
    page.locator('[data-remove="0"]').click(); page.locator('#keypad [data-k="save"]').click()
    page.locator('#sheet.open').wait_for(state='detached')
    assert [len(x) for x in counts(page)] == [1, 1, 1]
    page.locator('[data-view-action="edit"]').click()
    # The closed sheet keeps stale inputs until the asynchronous editor reload completes.
    expect(page.locator('#sheet.open #receipt-editor .receipt-item')).to_have_count(1)
    files = [image(page, f'虚构-{i}.png', '#36704b') for i in range(8)]
    page.locator('#sheet.open #receipt-editor input[type=file]').set_input_files(files)
    page.wait_for_function("document.querySelectorAll('.receipt-item').length === 9")
    assert page.locator('[data-receipt-add]').is_disabled()
    assert page.locator('#receipt-editor .receipt-strip').evaluate('e => e.scrollWidth > e.clientWidth')
    page.locator('#keypad [data-k="save"]').click(); page.locator('#sheet.open').wait_for(state='detached')
    page.wait_for_function("document.querySelectorAll('[data-view-receipt]').length === 9")
    assert page.locator('[data-view-receipt]').evaluate_all('(es) => es.every(e => e.getBoundingClientRect().width >= 144)')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.locator('#sp-entry-view [aria-label="账单凭证"]').scroll_into_view_if_needed(); page.wait_for_timeout(350)
    page.screenshot(path=str(OUT / f'detail-nine-{width}.png'), animations='disabled')


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            for width in (360, 390, 430, 1280):
                context = browser.new_context(viewport={'width': width, 'height': 900}, service_workers='block')
                try:
                    page = context.new_page(); page.set_default_timeout(9000)
                    run(page, width); print('PASS receipt lifecycle', width, flush=True)
                finally: context.close()
        finally: browser.close()
