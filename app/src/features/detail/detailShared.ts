/**
 * 拾光 · 明细模块共用小工具
 * 时间/类型文案格式化与批量改分类 / 改账户 / 退款账户共用的选择抽屉。
 */
import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import { LOAN_KIND_META, type Entry } from '../../core/types';
import { dayKey } from '../../core/repo/entryRepo';
import { openSheet, closeSheet } from '../shell/sheet';

export function fullDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function typeName(entry: Entry): string {
  if (entry.refundFlag) return '支出退款';
  if (entry.type === 'expense') return '支出';
  if (entry.type === 'income') return '收入';
  if (entry.type === 'transfer') return '转账';
  return LOAN_KIND_META[entry.loanKind ?? 'borrow'].name;
}

export function dayLabel(ts: number): string {
  const key = dayKey(ts);
  const [y, m, d] = key.split('-').map(Number);
  if (key === dayKey(Date.now())) return '今天';
  const md = `${m}月${d}日`;
  return y === new Date().getFullYear() ? md : `${y}年${md}`;
}

/* ── 选择抽屉（批量改分类 / 改账户共用） ── */

export function sheetPick(
  title: string,
  items: { id: number; label: string; icon?: string; note?: string }[],
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | undefined) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    openSheet({
      ariaLabel: title,
      render(el) {
        el.innerHTML = `
          <header class="sheet-head">
            <h3 style="font-size:15px;font-weight:600">${title}</h3>
            <button class="icon-btn" data-act="close" aria-label="关闭">${iconHtml('ic-close')}</button>
          </header>
          <div class="sheet-scroll" style="padding-bottom:14px">
            ${items.map((it) => `
              <button class="row" data-pick="${it.id}">
                <span class="e-ic neutral">${iconHtml(it.icon ?? 'ic-wallet', 16)}</span>${esc(it.label)}
                ${it.note ? `<span class="row-note num">${esc(it.note)}</span>` : ''}
              </button>`).join('')}
          </div>`;
        el.querySelector('[data-act="close"]')!.addEventListener('click', closeSheet);
        el.querySelector('.sheet-scroll')!.addEventListener('click', (e) => {
          const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]');
          if (!btn) return;
          done(Number(btn.dataset.pick));
          closeSheet();
        });
      },
      onClose() { done(undefined); },
    });
  });
}
