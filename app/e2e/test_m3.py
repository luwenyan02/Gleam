# -*- coding: utf-8 -*-
"""
拾光 M3 E2E 自测（Playwright，配合 webapp-testing/with_server.py 运行 vite preview）
阶段：A wacai.xls 五步导入 / B 重复导入全跳过 / C Excel 导出读回 /
      D 备份→清库→恢复一致 / E 加密备份口令 / F 搜索 / G PIN 锁 / H PWA 离线
"""
import re
import sys
import tempfile
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4601/')
WACAI = str(Path(__file__).parent / 'fixtures' / 'wacai-demo.xlsx')
TMP = Path(tempfile.mkdtemp(prefix='gleam_e2e_'))

RESULTS = []


def report(phase, ok, detail=''):
    RESULTS.append((phase, ok, detail))
    print(('PASS ' if ok else 'FAIL ') + phase + (': ' + detail if detail else ''), flush=True)


def goto_app(page):
    page.goto(URL)
    page.wait_for_selector('.tabbar', timeout=15000)
    page.wait_for_timeout(400)


def open_backup(page):
    page.click('.tab[data-page="page-mine"]')
    page.wait_for_selector('[data-sub="sp-backup"]', timeout=10000)
    page.click('[data-sub="sp-backup"]')
    page.wait_for_selector('#sp-backup [data-act="backup"]', timeout=10000)
    page.wait_for_timeout(300)


def entry_stats(page):
    return page.evaluate('''async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('GleamDB');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const rows = await new Promise((res, rej) => {
        const req = db.transaction('entries').objectStore('entries').getAll();
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      });
      db.close();
      const live = rows.filter((e) => e.deletedAt === 0);
      const byType = {};
      for (const e of live) byType[e.type] = (byType[e.type] || 0) + 1;
      const imported = live.filter((e) => e.importBatchId != null);
      const months = {};
      for (const e of imported) {
        const d = new Date(e.occurredAt);
        const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        months[k] = (months[k] || 0) + 1;
      }
      return { total: live.length, byType, imported: imported.length, months };
    }''')


def run_wizard(page, file_path):
    """备份页 → 选文件 → 预检 → 映射 → 导入 → 报告文本"""
    with page.expect_file_chooser() as fc:
        page.click('#sp-backup [data-act="pick-import"]')
    fc.value.set_files(file_path)
    page.wait_for_selector('#sp-import .imp-steps', timeout=15000)
    pre = page.inner_text('#sp-import')
    page.click('#sp-import [data-act="to-map"]')
    page.wait_for_selector('#sp-import [data-act="run"]', timeout=10000)
    page.click('#sp-import [data-act="run"]')
    # 疑似重复预检门：出现确认清单时需再次点击执行（默认跳过）
    try:
        page.wait_for_selector('#sp-import .imp-duplicates', timeout=3000)
        page.click('#sp-import [data-act="run"]')
    except Exception:
        pass
    page.wait_for_selector('#sp-import .imp-report', timeout=45000)
    rep = page.inner_text('#sp-import .imp-report')
    page.click('#sp-import [data-act="done"]')
    page.wait_for_timeout(500)
    return pre, rep


def parse_report(rep):
    ok_n = int(re.search(r'(\d+)\s*条成功入账', rep).group(1))
    skip_n = int(re.search(r'跳过(?:疑似)?重复\s*(\d+)\s*条', rep).group(1))
    return ok_n, skip_n


def dialog_ok(page, expect_text=None):
    page.wait_for_selector('#dialog-scrim.show .dialog', timeout=20000)
    txt = page.inner_text('#dialog-scrim .dialog')
    if expect_text:
        assert expect_text in txt, f'对话框缺少「{expect_text}」：{txt[:120]}'
    page.click('#dialog-scrim .dialog [data-act="ok"]')
    page.wait_for_timeout(400)
    return txt


def do_backup(page, password=None):
    """备份抽屉生成 .skbak，返回保存路径"""
    page.click('#sp-backup [data-act="backup"]')
    page.wait_for_selector('#sheet.open [data-act="gen"]', timeout=10000)
    if password:
        page.click('#sheet [data-act="enc"]')
        page.fill('#bk-p1', password)
        page.fill('#bk-p2', password)
    with page.expect_download(timeout=30000) as dl:
        page.click('#sheet [data-act="gen"]')
    path = TMP / dl.value.suggested_filename
    dl.value.save_as(str(path))
    page.wait_for_timeout(600)
    return path


def do_restore(page, path, password=None, expect_fail=False):
    with page.expect_file_chooser() as fc:
        page.click('#sp-backup [data-act="restore"]')
    fc.value.set_files(str(path))
    if password is not None:
        page.wait_for_selector('#sheet.open #rp-pwd', timeout=10000)
        page.fill('#rp-pwd', password)
        page.click('#sheet [data-act="ok"]')
    if expect_fail:
        return dialog_ok(page, '恢复未执行')
    dialog_ok(page, '确认恢复此备份')
    return dialog_ok(page, '恢复完成')


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # ctx1：禁 SW，保证路由拦截可用
        ctx = browser.new_context(service_workers='block', accept_downloads=True)
        page = ctx.new_page()
        page.on('pageerror', lambda e: print('PAGEERROR:', e))

        # ── A：wacai.xls 五步导入 ──
        goto_app(page)
        base = entry_stats(page)
        open_backup(page)
        pre, rep = run_wizard(page, WACAI)
        counts = {k: int(re.search(k + r'\s*(\d+)', pre).group(1))
                  for k in ('支出', '收入', '转账', '借贷')}
        ok_n, skip_n = parse_report(rep)
        after = entry_stats(page)
        total_rows = sum(counts.values())
        report('A wacai五步导入',
               ok_n + skip_n == total_rows and after['imported'] == ok_n and ok_n > 0,
               f'解析 {counts}，成功 {ok_n}，跳过 {skip_n}，落库 importBatch 条数 {after["imported"]}')
        wacai_counts, wacai_ok = counts, ok_n

        # ── B：重复导入全跳过 ──
        pre2, rep2 = run_wizard(page, WACAI)
        ok2, skip2 = parse_report(rep2)
        st_b = entry_stats(page)
        report('B 重复导入全跳过',
               ok2 == 0 and skip2 == total_rows and st_b['imported'] == wacai_ok,
               f'成功 {ok2}，跳过 {skip2}/{total_rows}')

        # ── C：Excel 导出读回 ──
        # 选 wacai 账单最多的月份导出（导入行为分钟精度，读回必判重）
        month, month_n = max(st_b['months'].items(), key=lambda kv: kv[1])
        # month is 'YYYY-MM' string; click month-pick button → monthWheel → __mwSet → confirm
        m_year, m_mon = int(month.split('-')[0]), int(month.split('-')[1])
        page.click('#bk-month')
        page.wait_for_selector('.dw-panel.dw-open', timeout=10000)
        page.wait_for_timeout(300)
        page.evaluate(f'''() => {{
            const panel = document.querySelector('.dw-panel');
            if (!panel || typeof panel.__mwSet !== 'function') {{
                throw new Error('month wheel panel or __mwSet hook missing');
            }}
            panel.__mwSet({m_year}, {m_mon});
        }}''')
        page.click('.dw-panel .dw-confirm')
        page.wait_for_selector('.dw-panel:not(.dw-open)', state='attached', timeout=10000)
        page.wait_for_timeout(300)
        with page.expect_download(timeout=30000) as dl:
            page.click('#sp-backup [data-act="excel"]')
        xlsx = TMP / dl.value.suggested_filename
        dl.value.save_as(str(xlsx))
        st_before_c = entry_stats(page)
        pre3, rep3 = run_wizard(page, str(xlsx))
        ok3, skip3 = parse_report(rep3)
        st_c = entry_stats(page)
        # 导出=分钟精度：该月 wacai 来源行必须全部判重跳过；秒级种子数据允许新建
        report('C Excel导出读回', skip3 >= month_n and '拾光账单' in xlsx.name,
               f'{xlsx.name}（月 {month}，wacai {month_n} 条）读回：成功 {ok3}（秒级种子容忍），跳过 {skip3} ≥ {month_n}')

        # ── D：备份→清库→恢复一致 ──
        st_before_d = entry_stats(page)
        skbak = do_backup(page)
        # 清库：拦掉 JS 加载纯 HTML，无连接状态下删库
        ctx.route('**/*.js', lambda r: r.abort())
        page.goto(URL)
        page.evaluate('''() => new Promise((res, rej) => {
          const r = indexedDB.deleteDatabase('GleamDB');
          r.onsuccess = res; r.onerror = () => rej(r.error);
          r.onblocked = () => rej(new Error('deleteDatabase blocked'));
        })''')
        ctx.unroute('**/*.js')
        goto_app(page)
        wiped = entry_stats(page)
        open_backup(page)
        do_restore(page, skbak)
        st_after_d = entry_stats(page)
        report('D 备份→清库→恢复一致',
               wiped['imported'] == 0
               and st_after_d['total'] == st_before_d['total']
               and st_after_d['byType'] == st_before_d['byType']
               and st_after_d['imported'] == st_before_d['imported'],
               f'备份 {skbak.name}；清库后 {wiped["total"]} 条（重播种）；'
               f'恢复后 {st_after_d["total"]} 条 == 备份前 {st_before_d["total"]} 条')

        # ── E：加密备份 错误口令拒绝 / 正确口令恢复 ──
        st_before_e = entry_stats(page)
        enc = do_backup(page, password='2468')
        fail_txt = do_restore(page, enc, password='0000', expect_fail=True)
        st_mid = entry_stats(page)
        do_restore(page, enc, password='2468')
        st_after_e = entry_stats(page)
        report('E 加密备份口令',
               st_mid['total'] == st_before_e['total'] and st_after_e['total'] == st_before_e['total'],
               f'错误口令→「{fail_txt.splitlines()[0]}」数据未动；正确口令恢复 {st_after_e["total"]} 条一致')

        # ── F：搜索命中 ──
        page.reload()
        page.wait_for_selector('.tabbar', timeout=15000)
        kw = page.evaluate('''async () => {
          const db = await new Promise((res, rej) => {
            const r = indexedDB.open('GleamDB');
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
          });
          const get = (s) => new Promise((res, rej) => {
            const q = db.transaction(s).objectStore(s).getAll();
            q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
          });
          const entries = (await get('entries')).filter((e) => e.deletedAt === 0 && e.categoryId != null);
          const cats = await get('categories');
          db.close();
          const byId = new Map(cats.map((c) => [c.id, c.name]));
          return entries.length ? byId.get(entries[0].categoryId) : null;
        }''')
        # reload 后默认在首页（首页 tab 隐藏），直接点页头搜索
        page.click('#btn-search')
        page.wait_for_selector('#sr-input', timeout=10000)
        page.fill('#sr-input', kw)
        page.wait_for_selector('#sr-results [data-eid]', timeout=10000)
        n_hit = page.locator('#sr-results [data-eid]').count()
        page.click('#sr-results [data-eid] .entry-swipe-content >> nth=0')
        page.wait_for_selector('#sp-entry-view.open', timeout=10000)
        # 验证详情子页展示了金额信息
        ev_hero = page.inner_text('#sp-entry-view .entry-view-hero')
        has_amount = '¥' in ev_hero or any(c.isdigit() for c in ev_hero)
        report('F 搜索命中', n_hit > 0 and has_amount,
               f'关键词「{kw}」命中账单 {n_hit} 条，点击打开 sp-entry-view 详情页成功，金额展示={has_amount}')

        # ── G：PIN 锁 ──
        page.reload()
        page.wait_for_selector('.tabbar', timeout=15000)
        page.click('.tab[data-page="page-mine"]')
        page.click('[data-sub="sp-settings"]')
        page.wait_for_selector('#sp-settings [data-sw="pin"]', timeout=10000)
        page.click('#sp-settings [data-sw="pin"]')
        page.wait_for_selector('#sheet.open #pin-1', timeout=10000)
        page.fill('#pin-1', '1234')
        page.fill('#pin-2', '1234')
        page.click('#sheet [data-act="ok"]')
        page.wait_for_selector('#sp-settings [data-sw="pin"].on', timeout=10000)
        page.reload()
        page.wait_for_selector('.lock-overlay input', timeout=15000)
        page.fill('.lock-overlay input', '0000')
        page.click('.lock-overlay [data-act="unlock"]')
        page.wait_for_function(
            '() => document.querySelector(".lock-overlay .lk-err")?.textContent.includes("不正确")',
            timeout=5000)
        wrong_blocked = page.locator('.lock-overlay').count() == 1
        page.fill('.lock-overlay input', '1234')
        page.click('.lock-overlay [data-act="unlock"]')
        page.wait_for_selector('.lock-overlay', state='detached', timeout=10000)
        page.wait_for_selector('.tabbar', timeout=15000)
        report('G PIN锁', wrong_blocked, '设置 1234 → 刷新出锁屏 → 0000 被拒 → 1234 解锁成功')
        # 收尾关闭 PIN，避免残留
        page.click('.tab[data-page="page-mine"]')
        page.click('[data-sub="sp-settings"]')
        page.wait_for_selector('#sp-settings [data-sw="pin"].on', timeout=10000)
        page.click('#sp-settings [data-sw="pin"]')
        page.wait_for_selector('#sheet.open #pin-old', timeout=10000)
        page.fill('#pin-old', '1234')
        page.click('#sheet [data-act="ok"]')
        page.wait_for_selector('#sp-settings [data-sw="pin"]:not(.on)', timeout=10000)
        ctx.close()

        # ── H：PWA 离线（允许 SW 的新 context）──
        ctx2 = browser.new_context()
        page2 = ctx2.new_page()
        page2.goto(URL)
        page2.wait_for_load_state('networkidle')
        page2.evaluate('() => navigator.serviceWorker.ready.then(() => true)')
        page2.wait_for_timeout(2500)  # 等 precache 完成
        ctx2.set_offline(True)
        page2.reload()
        page2.wait_for_selector('.tabbar', timeout=20000)
        report('H PWA离线', True, '断网 reload 后应用外壳正常加载')
        ctx2.close()
        browser.close()

    print('\n===== 汇总 =====')
    fails = [r for r in RESULTS if not r[1]]
    for name, ok, detail in RESULTS:
        print(('✅' if ok else '❌'), name, '-', detail)
    print(f'wacai 解析计数: {wacai_counts}')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
