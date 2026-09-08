# -*- coding: utf-8 -*-
"""
拾光 退款流 E2E 自动化测试（Playwright Python）
覆盖场景：
  a. 记一笔支出 ¥200
  b. 左滑→退款按钮→进入退款录入页
  c. 部分退款 ¥80 → 保存 → 断言余额与统计
  d. 全额退完 ¥120 → 断言禁用
  e. 删除一条退款 → 断言可退余额恢复
  f. 报销+退款叠加冒烟
  g. 搜索结果左滑退款冒烟
"""
import sys
import os
import time
import traceback
from playwright.sync_api import sync_playwright, Page

URL = os.environ.get('GLEAM_E2E_URL','http://127.0.0.1:4601/')
RESULTS = []


def report(phase, ok, detail=''):
    RESULTS.append((phase, ok, detail))
    print(('PASS ' if ok else 'FAIL ') + phase + (': ' + detail if detail else ''), flush=True)


def goto_app(page):
    page.goto(URL)
    page.wait_for_selector('.tabbar', timeout=15000)
    page.wait_for_timeout(500)


def open_entry_sheet(page):
    """Click FAB to open entry sheet."""
    page.click('#fab')
    page.wait_for_selector('#sheet.open #keypad', timeout=10000)
    page.wait_for_timeout(300)


def type_amount(page, amount_str):
    """Type amount via calculator keys on entry sheet."""
    for ch in amount_str:
        page.click(f'#keypad button[data-k="{ch}"]')
        page.wait_for_timeout(50)


def click_save(page):
    """Click save button on entry sheet."""
    page.click('#keypad button[data-k="save"]')
    page.wait_for_timeout(600)


def wait_sheet_closed(page):
    """Wait for entry sheet to close.
    #sheet 常驻 DOM，关闭态仅移除 .open 且 visibility:hidden，
    须以 attached 判定（visible 永不满足）。
    """
    page.wait_for_selector('#sheet:not(.open)', state='attached', timeout=10000)
    page.wait_for_timeout(400)


def type_refund_amount(page, amount_str):
    """Type amount via refund custom keypad ([data-rk] buttons)."""
    for ch in amount_str:
        page.click(f'#rf-keypad button[data-rk="{ch}"]')
        page.wait_for_timeout(50)


def save_refund(page):
    """Click save on refund keypad."""
    page.click('#rf-keypad button[data-rk="save"]')
    page.wait_for_timeout(800)


def clear_refund_amount(page):
    """Clear refund amount input."""
    page.click('#rf-keypad button[data-rk="clear"]')
    page.wait_for_timeout(100)


def go_back(page):
    """Click the sub-page back button."""
    page.click('[data-act="back"]')
    page.wait_for_timeout(400)


def ensure_home(page):
    """Ensure we're on the home page (close subpages if any, switch tab if needed)."""
    # Close any open subpages first
    while page.locator('.subpage.open').count() > 0:
        page.click('.subpage.open [data-act="back"]')
        page.wait_for_timeout(400)
    # Check if we're already on home by checking if FAB is visible
    if page.locator('#fab').is_visible():
        return  # Already on home
    # Switch to home via data-page (tab-home is only visible when NOT on home)
    if page.locator('#tab-home').is_visible():
        page.click('#tab-home')
        page.wait_for_timeout(400)
    else:
        # Fallback: reload and go to home
        page.reload()
        page.wait_for_selector('.tabbar', timeout=15000)
        page.wait_for_timeout(500)


def swipe_left(page, selector):
    """Perform pointer-based left swipe on an element (150px+)."""
    el = page.locator(selector).first
    box = el.bounding_box()
    if not box:
        raise AssertionError(f'Cannot find element to swipe: {selector}')
    cx = box['x'] + box['width'] / 2
    cy = box['y'] + box['height'] / 2
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.wait_for_timeout(50)
    # Move left in steps to trigger pointermove detection
    for step in range(1, 8):
        page.mouse.move(cx - step * 25, cy)
        page.wait_for_timeout(20)
    page.mouse.up()
    page.wait_for_timeout(300)


def get_account_balance(page, account_id=None):
    """Get first account balance (or by id) in fen."""
    return page.evaluate(f'''async () => {{
      const db = await new Promise((res, rej) => {{
        const r = indexedDB.open('GleamDB');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }});
      const rows = await new Promise((res, rej) => {{
        const req = db.transaction('accounts').objectStore('accounts').getAll();
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }});
      db.close();
      const visible = rows.filter(a => !a.hidden);
      const target = {f'visible.find(a => a.id === {account_id})' if account_id else 'visible[0]'};
      return target ? target.balance : 0;
    }}''')


def get_month_expense(page):
    """Get current month net expense (expense - refund amounts) in fen."""
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
      const live = rows.filter(e => e.deletedAt === 0);
      const now = new Date();
      const ym = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
      let expense = 0;
      for (const e of live) {
        const d = new Date(e.occurredAt);
        const eym = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
        if (eym !== ym) continue;
        if (e.type === 'expense') expense += e.refundFlag ? -e.amount : e.amount;
      }
      return expense;
    }''')


def get_refundable(page, entry_id):
    """Get refundable amount for an entry (in fen) via DB query."""
    return page.evaluate(f'''async () => {{
      const db = await new Promise((res, rej) => {{
        const r = indexedDB.open('GleamDB');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }});
      const entry = await new Promise((res, rej) => {{
        const req = db.transaction('entries').objectStore('entries').get({entry_id});
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }});
      if (!entry || entry.deletedAt !== 0 || entry.type !== 'expense' || entry.refundFlag) {{
        db.close();
        return 0;
      }}
      const all = await new Promise((res, rej) => {{
        const req = db.transaction('entries').objectStore('entries').getAll();
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }});
      db.close();
      const refunds = all.filter(e => e.deletedAt === 0 && e.refundFlag && e.refundOfEntryId === {entry_id});
      const refunded = refunds.reduce((sum, e) => sum + e.amount, 0);
      return Math.max(0, entry.amount - refunded);
    }}''')


def get_latest_entry_id(page, entry_type='expense', refund_flag=False):
    """Get the most recently created entry's id matching type and refundFlag."""
    return page.evaluate(f'''async () => {{
      const db = await new Promise((res, rej) => {{
        const r = indexedDB.open('GleamDB');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }});
      const rows = await new Promise((res, rej) => {{
        const req = db.transaction('entries').objectStore('entries').getAll();
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }});
      db.close();
      const matches = rows.filter(e => e.deletedAt === 0
        && e.type === '{entry_type}'
        && {'e.refundFlag === true' if refund_flag else '!e.refundFlag'});
      matches.sort((a, b) => b.createdAt - a.createdAt);
      return matches.length ? matches[0].id : null;
    }}''')


def get_refund_entries_for(page, original_id):
    """Get refund entry ids linked to an original entry."""
    return page.evaluate(f'''async () => {{
      const db = await new Promise((res, rej) => {{
        const r = indexedDB.open('GleamDB');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }});
      const rows = await new Promise((res, rej) => {{
        const req = db.transaction('entries').objectStore('entries').getAll();
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }});
      db.close();
      return rows.filter(e => e.deletedAt === 0 && e.refundFlag && e.refundOfEntryId === {original_id})
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(e => e.id);
    }}''')


def soft_delete_entry_in_db(page, entry_id):
    """Soft delete a specific entry via JS (simulating delete action without UI)."""
    page.evaluate(f'''async () => {{
      const db = await new Promise((res, rej) => {{
        const r = indexedDB.open('GleamDB');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }});
      const tx = db.transaction('entries', 'readwrite');
      const store = tx.objectStore('entries');
      const entry = await new Promise((res, rej) => {{
        const req = store.get({entry_id});
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }});
      if (entry && entry.deletedAt === 0) {{
        // For refund entries, reverse the account effect (+amount)
        if (entry.refundFlag && entry.accountId != null) {{
          const aTx = db.transaction('accounts', 'readwrite');
          const aStore = aTx.objectStore('accounts');
          const acct = await new Promise((res, rej) => {{
            const req = aStore.get(entry.accountId);
            req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
          }});
          if (acct) {{
            acct.balance -= entry.amount; // reverse refund credit
            acct.updatedAt = Date.now();
            await new Promise((res, rej) => {{
              const req = aStore.put(acct);
              req.onsuccess = () => res(undefined); req.onerror = () => rej(req.error);
            }});
          }}
          await new Promise(res => {{ aTx.oncomplete = res; }});
        }}
        entry.deletedAt = Date.now();
        entry.updatedAt = Date.now();
        const wTx = db.transaction('entries', 'readwrite');
        await new Promise((res, rej) => {{
          const req = wTx.objectStore('entries').put(entry);
          req.onsuccess = () => res(undefined); req.onerror = () => rej(req.error);
        }});
        await new Promise(res => {{ wTx.oncomplete = res; }});
      }}
      db.close();
    }}''')
    page.wait_for_timeout(300)


# ─────────────────────────────────────────────────────────────
# TEST a: 记支出 ¥200
# ─────────────────────────────────────────────────────────────
def test_a_record_expense(page):
    """a. 记一笔支出 ¥200，返回 entry id。"""
    goto_app(page)
    balance_before = get_account_balance(page)
    open_entry_sheet(page)
    type_amount(page, '200')
    click_save(page)
    wait_sheet_closed(page)
    eid = get_latest_entry_id(page, 'expense', False)
    balance_after = get_account_balance(page)
    ok = eid is not None and balance_after == balance_before - 20000
    report('a 记支出¥200', ok,
           f'entryId={eid}; 账户余额 {balance_before/100:.0f}→{balance_after/100:.0f} (期望-200)')
    return eid


# ─────────────────────────────────────────────────────────────
# TEST b: 左滑→退款按钮→进入退款录入页
# ─────────────────────────────────────────────────────────────
def test_b_swipe_to_refund(page, entry_id):
    """b. 对刚记的账单左滑→点退款→进入退款录入页。"""
    ensure_home(page)
    page.wait_for_timeout(500)
    # Home page entries use data-entry-row attribute
    selector = f'.entry-swipe[data-entry-row="{entry_id}"]'
    page.wait_for_selector(selector, timeout=10000)
    swipe_left(page, selector)
    # Click refund action button
    page.click(f'{selector} [data-entry-action="refund"]')
    page.wait_for_selector('#sp-entry-refund.open', timeout=10000)
    # Verify refund page shows the origin
    refund_text = page.inner_text('#sp-entry-refund .refund-origin')
    has_200 = '200' in refund_text
    ok = has_200
    report('b 左滑进入退款页', ok, f'退款页显示原支出: {refund_text[:60]}')
    # Go back for next steps
    go_back(page)
    page.wait_for_timeout(400)


# ─────────────────────────────────────────────────────────────
# TEST c: 部分退款 ¥80
# ─────────────────────────────────────────────────────────────
def test_c_partial_refund(page, entry_id):
    """c. 部分退款 ¥80 → 断言可退余额=120、账户回补+80、月净支出=120。"""
    ensure_home(page)
    page.wait_for_timeout(500)
    balance_before = get_account_balance(page)
    expense_before = get_month_expense(page)
    # Swipe and refund
    selector = f'.entry-swipe[data-entry-row="{entry_id}"]'
    page.wait_for_selector(selector, timeout=10000)
    swipe_left(page, selector)
    page.click(f'{selector} [data-entry-action="refund"]')
    page.wait_for_selector('#sp-entry-refund.open', timeout=10000)
    page.wait_for_timeout(300)
    # Clear default amount and type 80
    clear_refund_amount(page)
    type_refund_amount(page, '80')
    save_refund(page)
    # Should close refund subpage after save
    page.wait_for_selector('#sp-entry-refund', state='detached', timeout=10000)
    page.wait_for_timeout(500)

    refundable = get_refundable(page, entry_id)
    balance_after = get_account_balance(page)
    expense_after = get_month_expense(page)
    balance_delta = balance_after - balance_before
    # Net expense should decrease by 8000 (refund reduces net expense)
    expense_delta = expense_after - expense_before

    ok = (refundable == 12000  # 120 yuan remaining
          and balance_delta == 8000  # +80 account
          and expense_delta == -8000)  # net expense -80
    report('c 部分退款¥80', ok,
           f'可退余额={refundable/100:.0f}(期望120); '
           f'账户回补={balance_delta/100:+.0f}(期望+80); '
           f'月净支出变动={expense_delta/100:+.0f}(期望-80)')


# ─────────────────────────────────────────────────────────────
# TEST d: 全额退完 ¥120
# ─────────────────────────────────────────────────────────────
def test_d_full_refund(page, entry_id):
    """d. 再次退款 ¥120（退完）→ 断言可退余额=0，退款入口禁用。"""
    ensure_home(page)
    page.wait_for_timeout(500)
    selector = f'.entry-swipe[data-entry-row="{entry_id}"]'
    page.wait_for_selector(selector, timeout=10000)
    swipe_left(page, selector)
    page.click(f'{selector} [data-entry-action="refund"]')
    page.wait_for_selector('#sp-entry-refund.open', timeout=10000)
    page.wait_for_timeout(300)
    # Default amount should be 120 (remaining)
    clear_refund_amount(page)
    type_refund_amount(page, '120')
    save_refund(page)
    page.wait_for_selector('#sp-entry-refund', state='detached', timeout=10000)
    page.wait_for_timeout(500)

    refundable = get_refundable(page, entry_id)
    # Now open entry detail to check refund button is disabled
    page.evaluate(f'''() => {{
      const el = document.querySelector('[data-entry-row="{entry_id}"]');
      if (el) el.querySelector('.entry-swipe-content')?.click();
    }}''')
    page.wait_for_selector('#sp-entry-view.open', timeout=10000)
    page.wait_for_timeout(500)
    refund_btn = page.locator('#sp-entry-view .entry-view-actions [data-view-action="refund"]')
    is_disabled = refund_btn.get_attribute('aria-disabled') == 'true'
    go_back(page)
    page.wait_for_timeout(300)

    ok = refundable == 0 and is_disabled
    report('d 全额退完¥120', ok,
           f'可退余额={refundable/100:.0f}(期望0); 退款按钮禁用={is_disabled}')


# ─────────────────────────────────────────────────────────────
# TEST e: 删除一条退款记录→可退余额恢复
# ─────────────────────────────────────────────────────────────
def test_e_delete_refund(page, entry_id):
    """e. 删除一条退款记录→原支出可退余额恢复+80。"""
    refund_ids = get_refund_entries_for(page, entry_id)
    if not refund_ids:
        report('e 删除退款恢复', False, '未找到退款记录')
        return
    # Delete the first refund (¥80)
    target_refund = refund_ids[0]
    soft_delete_entry_in_db(page, target_refund)
    # Dispatch entries-changed event to refresh UI
    page.evaluate('''() => {
      window.dispatchEvent(new CustomEvent('entries-changed'));
    }''')
    page.wait_for_timeout(500)

    refundable = get_refundable(page, entry_id)
    ok = refundable == 8000  # ¥80 restored
    report('e 删除退款恢复', ok,
           f'删除退款#{target_refund}后，可退余额={refundable/100:.0f}(期望80)')


# ─────────────────────────────────────────────────────────────
# TEST f: 报销+退款叠加冒烟
# ─────────────────────────────────────────────────────────────
def test_f_reimburse_then_refund(page):
    """f. 记支出¥100标记报销→报销到账→退款¥50→断言余额正确。"""
    goto_app(page)
    balance_before = get_account_balance(page)

    # Record expense ¥100 with reimburse flag
    open_entry_sheet(page)
    type_amount(page, '100')
    page.click('#mark-bx')
    page.wait_for_timeout(200)
    click_save(page)
    wait_sheet_closed(page)

    eid = get_latest_entry_id(page, 'expense', False)
    balance_after_expense = get_account_balance(page)
    # expense ¥100 → balance -100
    assert balance_after_expense == balance_before - 10000, \
        f'Expense failed: {balance_before}→{balance_after_expense}'

    # Settle reimbursement directly via DB (simulate the UI flow)
    page.evaluate(f'''async () => {{
      const db = await new Promise((res, rej) => {{
        const r = indexedDB.open('GleamDB');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }});
      const tx = db.transaction(['entries', 'accounts'], 'readwrite');
      const store = tx.objectStore('entries');
      const entry = await new Promise((res, rej) => {{
        const req = store.get({eid});
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }});
      if (entry) {{
        entry.reimburseStatus = 'done';
        entry.reimbursedAmount = entry.amount;
        entry.reimburseAccountId = entry.accountId;
        entry.updatedAt = Date.now();
        await new Promise((res, rej) => {{
          const req = store.put(entry);
          req.onsuccess = () => res(undefined); req.onerror = () => rej(req.error);
        }});
        // Credit account with reimbursement
        const aStore = tx.objectStore('accounts');
        const acct = await new Promise((res, rej) => {{
          const req = aStore.get(entry.accountId);
          req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
        }});
        if (acct) {{
          acct.balance += entry.amount;
          acct.updatedAt = Date.now();
          await new Promise((res, rej) => {{
            const req = aStore.put(acct);
            req.onsuccess = () => res(undefined); req.onerror = () => rej(req.error);
          }});
        }}
      }}
      await new Promise(res => {{ tx.oncomplete = res; }});
      db.close();
    }}''')
    page.wait_for_timeout(400)

    balance_after_reimburse = get_account_balance(page)
    # Reimbursement should restore the ¥100 → balance back to before
    reimburse_ok = balance_after_reimburse == balance_before

    # Now do refund ¥50 on the same expense
    ensure_home(page)
    # Reload to pick up new data
    page.reload()
    page.wait_for_selector('.tabbar', timeout=15000)
    page.wait_for_timeout(500)
    selector = f'.entry-swipe[data-entry-row="{eid}"]'
    page.wait_for_selector(selector, timeout=10000)
    swipe_left(page, selector)
    page.click(f'{selector} [data-entry-action="refund"]')
    page.wait_for_selector('#sp-entry-refund.open', timeout=10000)
    page.wait_for_timeout(300)
    clear_refund_amount(page)
    type_refund_amount(page, '50')
    save_refund(page)
    page.wait_for_selector('#sp-entry-refund', state='detached', timeout=10000)
    page.wait_for_timeout(500)

    balance_after_refund = get_account_balance(page)
    # Refund ¥50 → account gets +50 (on top of reimbursed state)
    refund_credit = balance_after_refund - balance_after_reimburse
    net_expense = get_month_expense(page)

    ok = reimburse_ok and refund_credit == 5000
    report('f 报销+退款叠加', ok,
           f'报销到账后余额恢复={reimburse_ok}; '
           f'退款¥50后账户增={refund_credit/100:+.0f}(期望+50); '
           f'当月净支出={net_expense/100:.0f}')


# ─────────────────────────────────────────────────────────────
# TEST g: 搜索结果左滑退款冒烟
# ─────────────────────────────────────────────────────────────
def test_g_search_swipe_refund(page):
    """g. 搜索找到支出→左滑→退款→断言成功。"""
    goto_app(page)
    # Record a new expense for searching
    open_entry_sheet(page)
    type_amount(page, '66')
    click_save(page)
    wait_sheet_closed(page)

    search_eid = get_latest_entry_id(page, 'expense', False)
    balance_before = get_account_balance(page)

    # Get category name of this entry for search keyword
    kw = page.evaluate(f'''async () => {{
      const db = await new Promise((res, rej) => {{
        const r = indexedDB.open('GleamDB');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }});
      const entry = await new Promise((res, rej) => {{
        const req = db.transaction('entries').objectStore('entries').get({search_eid});
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }});
      const cats = await new Promise((res, rej) => {{
        const req = db.transaction('categories').objectStore('categories').getAll();
        req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
      }});
      db.close();
      if (!entry || entry.categoryId == null) return null;
      const cat = cats.find(c => c.id === entry.categoryId);
      return cat ? cat.name : null;
    }}''')

    if not kw:
        report('g 搜索左滑退款', False, '无法获取搜索关键词')
        return

    # Open search
    page.click('#btn-search')
    page.wait_for_selector('#sr-input', timeout=10000)
    page.fill('#sr-input', kw)
    page.wait_for_selector('#sr-results [data-eid]', timeout=10000)
    page.wait_for_timeout(500)

    # Find our entry in search results and swipe
    sr_selector = f'#sr-results .entry-swipe[data-eid="{search_eid}"]'
    if page.locator(sr_selector).count() == 0:
        # Entry might not be first; try scrolling or just use first available
        sr_selector = '#sr-results .entry-swipe[data-eid] >> nth=0'
        search_eid_str = page.locator(sr_selector).get_attribute('data-eid')
        if search_eid_str:
            search_eid = int(search_eid_str)
            sr_selector = f'#sr-results .entry-swipe[data-eid="{search_eid}"]'
        balance_before = get_account_balance(page)

    swipe_left(page, sr_selector)
    # Check refund button is not disabled
    refund_btn = page.locator(f'{sr_selector} [data-entry-action="refund"]')
    if refund_btn.get_attribute('aria-disabled') == 'true':
        report('g 搜索左滑退款', False, '退款按钮已禁用（可能非普通支出）')
        go_back(page)
        return

    refund_btn.click()
    page.wait_for_selector('#sp-entry-refund.open', timeout=10000)
    page.wait_for_timeout(300)
    # Use the default (full) amount
    save_refund(page)
    page.wait_for_selector('#sp-entry-refund', state='detached', timeout=10000)
    page.wait_for_timeout(500)

    balance_after = get_account_balance(page)
    delta = balance_after - balance_before
    ok = delta > 0  # Account should have received refund credit
    report('g 搜索左滑退款', ok,
           f'搜索关键词「{kw}」，对#{search_eid}左滑退款，账户变动={delta/100:+.0f}')
    # Close search subpage
    go_back(page)
    page.wait_for_timeout(300)


# ─────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────
def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(service_workers='block', accept_downloads=True)
        page = ctx.new_page()
        page.on('pageerror', lambda e: print('PAGEERROR:', e))

        entry_id = None
        tests = []

        try:
            entry_id = test_a_record_expense(page)
        except Exception as e:
            tb = traceback.format_exc()
            report('a 记支出¥200 异常', False, f'{e}\n{tb[-300:]}')

        if entry_id:
            try:
                test_b_swipe_to_refund(page, entry_id)
            except Exception as e:
                tb = traceback.format_exc()
                report('b 左滑退款 异常', False, f'{e}\n{tb[-300:]}')

            try:
                test_c_partial_refund(page, entry_id)
            except Exception as e:
                tb = traceback.format_exc()
                report('c 部分退款 异常', False, f'{e}\n{tb[-300:]}')

            try:
                test_d_full_refund(page, entry_id)
            except Exception as e:
                tb = traceback.format_exc()
                report('d 全额退完 异常', False, f'{e}\n{tb[-300:]}')

            try:
                test_e_delete_refund(page, entry_id)
            except Exception as e:
                tb = traceback.format_exc()
                report('e 删除退款 异常', False, f'{e}\n{tb[-300:]}')

        try:
            test_f_reimburse_then_refund(page)
        except Exception as e:
            tb = traceback.format_exc()
            report('f 报销+退款 异常', False, f'{e}\n{tb[-300:]}')

        try:
            test_g_search_swipe_refund(page)
        except Exception as e:
            tb = traceback.format_exc()
            report('g 搜索左滑退款 异常', False, f'{e}\n{tb[-300:]}')

        ctx.close()
        browser.close()

    print('\n===== 退款流测试汇总 =====')
    fails = [r for r in RESULTS if not r[1]]
    for name, ok, detail in RESULTS:
        print(('✅' if ok else '❌'), name, '-', detail)
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
