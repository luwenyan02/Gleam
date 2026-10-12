"""普通账单凭证闭环，全部图片为 canvas 合成的虚构测试素材。"""
import base64
import json
import time
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


GEOMETRY = r"""() => {
  const panel=document.querySelector('#sp-entry-view.open');
  return Array.from(panel?.querySelectorAll('[data-view-receipt]') ?? [], (e,index) => {
    const rect=e.getBoundingClientRect(), css=getComputedStyle(e), ancestors=[];
    for(let node=e;node;node=node.parentElement) {
      const style=getComputedStyle(node);
      ancestors.push({tag:node.tagName,id:node.id,transform:style.transform,
        animations:node.getAnimations().map(a=>a.playState)});
    }
    return {index,width:rect.width,height:rect.height,x:rect.x,y:rect.y,
      layoutWidth:e.offsetWidth,computedWidth:parseFloat(css.width),flexBasis:css.flexBasis,
      display:css.display,visibility:css.visibility,transform:css.transform,ancestors};
  });
}"""


def stable_receipt_geometry(page, width):
    deadline, previous, stable = time.monotonic() + 9, None, 0
    snapshot = []
    while time.monotonic() < deadline:
        snapshot = page.evaluate(GEOMETRY)
        ready = len(snapshot) == 9 and all(
            row['width'] > 0 and row['height'] > 0 and row['visibility'] == 'visible'
            and not any('running' in node['animations'] for node in row['ancestors'])
            for row in snapshot)
        stable = stable + 1 if ready and snapshot == previous else 0
        if stable >= 2:
            return snapshot
        previous = snapshot
        page.wait_for_timeout(50)
    receipt_geometry_failure(page, width, snapshot, 'geometry did not settle')


def receipt_geometry_failure(page, width, snapshot, reason):
    diagnostic = {'viewport': width, 'reason': reason, 'receipts': snapshot}
    (OUT / f'geometry-failure-{width}.json').write_text(json.dumps(diagnostic, ensure_ascii=False, indent=2))
    print('RECEIPT_GEOMETRY ' + json.dumps(diagnostic, ensure_ascii=False), flush=True)
    page.screenshot(path=str(OUT / f'geometry-failure-{width}.png'), animations='disabled')
    raise AssertionError('Receipt thumbnails must remain at least 144px: ' + json.dumps(diagnostic, ensure_ascii=False))


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
    geometry = stable_receipt_geometry(page, width)
    # Keep the actual 144px layout requirement. Only tolerate millionth-of-a-pixel
    # DOMRect subtraction noise; this cannot accept a genuinely shrunken control.
    if not all(row['computedWidth'] >= 144 and row['layoutWidth'] >= 144
               and row['width'] + 1e-6 >= 144 for row in geometry):
        receipt_geometry_failure(page, width, geometry, 'thumbnail below 144px')
    print('RECEIPT_GEOMETRY ' + json.dumps({'viewport': width, 'receipts': geometry}), flush=True)
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
