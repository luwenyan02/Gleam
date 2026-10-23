# -*- coding: utf-8 -*-
"""M3 生活流、设置分组、安全凭据与可访问性验收。"""

import os
import sys
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright, expect


URL = os.environ.get('GLEAM_E2E_URL', 'http://127.0.0.1:4173/')
SCREENSHOTS = Path(os.environ.get(
    'GLEAM_E2E_SCREENSHOTS',
    Path(__file__).parents[2] / '.tmp' / 'tests' / 'e2e' / 'screenshots',
))
SCREENSHOTS.mkdir(parents=True, exist_ok=True)


def put_legacy_secrets(page) -> None:
    page.evaluate('''async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const now = Date.now();
      store.put({ key: 'security.secretsMigrated', value: false, updatedAt: now });
      store.put({ key: 'ai.apiKey', value: 'demo-ai-secret', updatedAt: now });
      store.put({ key: 'cloud.webdav', value: { server: 'https://example.invalid', username: 'demo', password: 'demo-dav-secret', path: 'demo' }, updatedAt: now });
      store.put({ key: 'cloud.s3', value: { endpoint: '', region: 'auto', bucket: 'demo', accessKey: 'demo-access', secretKey: 'demo-s3-secret', prefix: 'demo/' }, updatedAt: now });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      sessionStorage.clear();
    }''')


def legacy_settings_are_cleared(page) -> bool:
    return page.evaluate('''async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('GleamDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve, reject) => {
        const request = db.transaction('settings').objectStore('settings').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const map = Object.fromEntries(rows.map(row => [row.key, row.value]));
      return map['security.secretsMigrated'] === true
        && map['ai.apiKey'] === ''
        && map['cloud.webdav'].password === ''
        && map['cloud.s3'].accessKey === ''
        && map['cloud.s3'].secretKey === '';
    }''')


def main() -> int:
    failure = None
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
        page = context.new_page()
        page.on('pageerror', lambda error: print(f'PAGEERROR: {error}', flush=True))
        try:
            page.goto(URL)
            page.wait_for_load_state('networkidle')
            page.wait_for_selector('.tabbar', timeout=15_000)

            put_legacy_secrets(page)
            page.reload()
            page.wait_for_load_state('networkidle')
            page.wait_for_selector('.tabbar', timeout=15_000)
            assert legacy_settings_are_cleared(page), '旧 IndexedDB 明文凭据未清空'
            assert page.evaluate("sessionStorage.getItem('gleam-secret:ai.apiKey') !== null")
            assert page.evaluate("sessionStorage.getItem('gleam-secret:cloud.webdav.password') !== null")

            page.click('.tab[data-page="page-life"]')
            page.wait_for_selector('#page-life.is-active #lf-types')
            assert page.locator('#lf-add').count() == 0
            assert page.locator('#fab-life:visible').count() == 1, '空状态也可从底部打开对话'
            assert page.get_attribute('#page-home', 'aria-hidden') == 'true'
            assert page.eval_on_selector('#page-home', 'el => el.inert') is True

            page.click('#lf-types')
            page.wait_for_selector('#sheet.open')
            page.wait_for_timeout(350)
            assert page.eval_on_selector('#sheet', 'el => el.contains(document.activeElement)') is True
            page.keyboard.press('Escape')
            page.wait_for_selector('#sheet:not(.open)', state='attached')
            page.wait_for_timeout(100)
            assert page.evaluate("document.activeElement?.id === 'lf-types'"), '关闭弹层后焦点未回到触发按钮'

            page.click('#lf-types')
            page.click('#sheet [data-type="habit"]')
            page.fill('#lf-hname', '散步')
            page.click('#sheet [data-act="save"]')
            page.wait_for_selector('#sheet:not(.open)', state='attached')
            page.wait_for_selector('#lf-feed .habit')
            assert page.locator('#fab-life:visible').count() == 1

            page.click('#lf-types')
            page.click('#sheet [data-type="diary"]')
            page.fill('#lf-title', '今天的光')
            page.fill('#lf-body', '晚风很轻。')
            page.click('#sheet [data-act="save"]')
            page.wait_for_selector('#sheet:not(.open)', state='attached')
            page.wait_for_selector('#lf-feed [data-note]')
            page.wait_for_timeout(400)
            assert page.locator('#lf-feed .habit').count() == 1
            assert page.locator('#lf-feed [data-note]').count() == 1
            page.screenshot(path=str(SCREENSHOTS / 'm3-life-timeline-390x844.png'))

            page.click('.tab[data-page="page-mine"]')
            page.wait_for_selector('#page-mine.is-active .mine-group')
            headings = page.locator('#page-mine .mine-group>h3').all_inner_texts()
            assert headings == ['记账偏好', '数据与备份', '智能能力与通知', '外观与安全', '关于和帮助']

            page.click('#page-mine [data-sub="sp-settings"]')
            page.wait_for_selector('#sp-settings.open section[aria-label="记账偏好"]')
            page.wait_for_timeout(350)
            labels = page.locator('#sp-settings .sub-body>section.card').evaluate_all(
                "els => els.map(el => el.getAttribute('aria-label'))"
            )
            assert labels == ['记账偏好', '数据', '智能能力', '通知', '外观', '安全'], f'设置分组或顺序不符：{labels}'
            assert page.locator('#sp-settings [data-freq], #sp-settings [data-sw="ntf-backup"]').count() == 0
            assert page.locator('#sp-settings #ai-key').count() == 0
            expect(page.locator('#sp-settings [data-act="ai-settings"]')).to_be_visible()
            assert page.locator('#sp-settings [data-act="settings-manual"]').count() == 0
            page.click('#sp-settings [data-act="back"]')
            page.wait_for_selector('#sp-settings', state='detached')
            page.locator('#page-mine section[aria-label="关于和帮助"]').get_by_role('button', name='使用手册', exact=False).click()
            page.wait_for_selector('#sheet.open[aria-label="拾光使用手册"]')
            page.locator('#sheet .manual-notes summary').click()
            assert '当前标签页会话' in page.inner_text('#sheet')
            page.click('[data-manual-close]')
            page.wait_for_selector('#sheet.open', state='hidden')

            page.click('#page-mine [data-sub="sp-backup"]')
            page.wait_for_selector('#sp-backup.open .bk-group-title')
            page.wait_for_timeout(350)
            groups = page.locator('#sp-backup .bk-group-title').all_inner_texts()
            assert groups == ['立即备份', '云端配置', '恢复与历史', 'Excel 导入导出']
            assert page.locator('#sp-backup .map-table').count() == 0
            assert page.get_attribute('#page-mine', 'aria-hidden') == 'true'
            assert page.eval_on_selector('#page-mine', 'el => el.inert') is True
            assert page.get_attribute('.tabbar', 'aria-hidden') == 'true'
            violations = page.locator('#sp-backup button:visible').evaluate_all(
                "els => els.map(el => ({text: el.textContent?.trim(), ...el.getBoundingClientRect().toJSON()})).filter(r => r.width < 43 || r.height < 43)"
            )
            assert violations == [], f'备份页存在小于 44×44 的触控目标：{violations}'
            page.screenshot(path=str(SCREENSHOTS / 'm3-backup-groups-390x844.png'))

            print('PASS M3 life/settings/secrets/accessibility', flush=True)
        except Exception as error:  # noqa: BLE001
            failure = f'{error}\n{traceback.format_exc()}'
            page.screenshot(path=str(SCREENSHOTS / 'm3-ux-fail.png'))
            print(f'FAIL M3 life/settings/secrets/accessibility: {error}', flush=True)
        finally:
            context.close()
            browser.close()

    if failure:
        print(failure)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
