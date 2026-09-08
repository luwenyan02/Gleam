# -*- coding: utf-8 -*-
"""SKBAK v1 production-preview checks through the real backup and restore UI."""
import hashlib
import json
import os
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright
from test_m3 import do_backup, do_restore, open_backup


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4601/')
WORK = Path(tempfile.mkdtemp(prefix='gleam_backup_integrity_'))
ATTACHMENT_ID = 7001


def seed_icon_photo(page):
    """Store the bundled app icon as a fictional photo through native IndexedDB."""
    return page.evaluate(
        '''async attachmentId => {
          const icon = await (await fetch('/icons/icon-192.png')).blob();
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const tx = db.transaction(['attachments', 'lifeNotes'], 'readwrite');
          const now = 1788796800000;
          tx.objectStore('attachments').put({
            id: attachmentId,
            mime: icon.type || 'image/png',
            name: '虚构App图标照片.png',
            size: icon.size,
            blob: icon,
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('lifeNotes').put({
            id: attachmentId,
            kind: 'photo',
            title: '虚构App图标照片',
            photoRefs: [attachmentId],
            occurredAt: now,
            deletedAt: 0,
            createdAt: now,
            updatedAt: now,
          });
          await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          });
          db.close();
          return { size: icon.size, mime: icon.type };
        }''',
        ATTACHMENT_ID,
    )


def database_fingerprint(page):
    """Read every main-database count plus exact sentinel Blob metadata and SHA-256."""
    return page.evaluate(
        '''async attachmentId => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const names = [...db.objectStoreNames];
          const tx = db.transaction(names, 'readonly');
          const request = (store, method, key) => new Promise((resolve, reject) => {
            const result = key === undefined
              ? tx.objectStore(store)[method]()
              : tx.objectStore(store)[method](key);
            result.onsuccess = () => resolve(result.result);
            result.onerror = () => reject(result.error);
          });
          const countsPromise = Promise.all(names.map(async name => [name, await request(name, 'count')]));
          const attachmentPromise = request('attachments', 'get', attachmentId);
          const notePromise = request('lifeNotes', 'get', attachmentId);
          const [counts, attachment, note] = await Promise.all([
            countsPromise, attachmentPromise, notePromise,
          ]);
          db.close();
          if (!attachment) return { counts: Object.fromEntries(counts), attachment: null, note };
          const bytes = await attachment.blob.arrayBuffer();
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          return {
            counts: Object.fromEntries(counts),
            attachment: {
              id: attachment.id,
              mime: attachment.mime,
              name: attachment.name,
              declaredSize: attachment.size,
              blobSize: attachment.blob.size,
              byteLength: bytes.byteLength,
              sha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''),
            },
            note: note ? {
              id: note.id,
              kind: note.kind,
              title: note.title,
              photoRefs: note.photoRefs,
            } : null,
          };
        }''',
        ATTACHMENT_ID,
    )


def delete_icon_photo(page):
    page.evaluate(
        '''async attachmentId => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('GleamDB');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const tx = db.transaction(['attachments', 'lifeNotes'], 'readwrite');
          tx.objectStore('attachments').delete(attachmentId);
          tx.objectStore('lifeNotes').delete(attachmentId);
          await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          });
          db.close();
        }''',
        ATTACHMENT_ID,
    )


def corrupt_backup(source, name, kind):
    target = WORK / name
    with zipfile.ZipFile(source, 'r') as archive:
        members = [(info, archive.read(info.filename)) for info in archive.infolist()]
    payloads = {info.filename: content for info, content in members}
    manifest = json.loads(payloads['manifest.json'])

    omitted = set()
    if kind == 'missing_attachment':
        omitted.add(f'attachments/{ATTACHMENT_ID}')
    elif kind == 'count_mismatch':
        manifest['counts']['attachments'] += 1
        payloads['manifest.json'] = json.dumps(manifest, ensure_ascii=False).encode('utf-8')
    elif kind == 'missing_table':
        data = json.loads(payloads['data.json'])
        del data['settings']
        data_bytes = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        manifest['checksum'] = hashlib.sha256(data_bytes).hexdigest()
        payloads['data.json'] = data_bytes
        payloads['manifest.json'] = json.dumps(manifest, ensure_ascii=False).encode('utf-8')
    else:
        raise ValueError(f'unknown corruption kind: {kind}')

    with zipfile.ZipFile(target, 'w') as archive:
        for info, _ in members:
            if info.filename not in omitted:
                archive.writestr(info, payloads[info.filename])
    return target


def assert_round_trip(page, password=None):
    before = database_fingerprint(page)
    backup = do_backup(page, password=password)
    delete_icon_photo(page)
    assert database_fingerprint(page)['attachment'] is None
    do_restore(page, backup, password=password)
    page.wait_for_timeout(300)
    after = database_fingerprint(page)
    assert after == before, {'before': before, 'after': after, 'encrypted': password is not None}


def assert_corrupt_backups_are_rejected(page):
    source = do_backup(page)
    with zipfile.ZipFile(source, 'r') as archive:
        assert f'attachments/{ATTACHMENT_ID}' in archive.namelist()
    baseline = database_fingerprint(page)
    cases = (
        ('missing_attachment', '附件'),
        ('count_mismatch', '计数'),
        ('missing_table', '数据表 settings'),
    )
    for kind, expected in cases:
        broken = corrupt_backup(source, f'{kind}.skbak', kind)
        message = do_restore(page, broken, expect_fail=True)
        assert expected in message, {'kind': kind, 'message': message}
        assert database_fingerprint(page) == baseline, kind


def backup_integrity(page):
    page.goto(URL)
    page.wait_for_selector('.tabbar', timeout=15_000)
    page.wait_for_timeout(400)
    seeded = seed_icon_photo(page)
    assert seeded['size'] > 0 and seeded['mime'] == 'image/png', seeded
    open_backup(page)

    assert_round_trip(page)
    assert_round_trip(page, password='fiction-password')
    assert_corrupt_backups_are_rejected(page)


if __name__ == '__main__':
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 390, 'height': 844},
            service_workers='block',
            accept_downloads=True,
        )
        page = context.new_page()
        page.set_default_timeout(20_000)
        backup_integrity(page)
        print('PASS backup_integrity', flush=True)
        context.close()
        browser.close()
