import { iconHtml } from '../../assets/icons';
import { categoryIcon } from '../../core/categoryIcons';
import { esc } from '../../core/esc';
import type { Category, CategoryKind } from '../../core/types';
import { listCategories } from '../../core/repo/categoryRepo';
import { categoryPath, mergeCategories, previewCategoryMerge, type CategoryMergePreview } from '../../core/repo/categoryMergeRepo';
import { createSnapshot } from '../../core/repo/backupRepo';
import { openSheet, closeSheet } from '../shell/sheet';
import { showToast } from '../shell/toast';

const head = (title: string) => `<div class="cm-sheet-head"><h3 class="sheet-title">${title}</h3><button class="icon-btn" data-merge-close aria-label="关闭分类合并">${iconHtml('ic-close')}</button></div>`;
const message = (error: unknown) => error instanceof Error ? error.message : '分类合并失败，请重试';

/** A dedicated flow keeps merge selection separate from unsaved category edits. */
export async function openCategoryMerge(kind: CategoryKind, host: HTMLElement): Promise<void> {
  const categories = await listCategories(kind);
  if (!host.isConnected) return;
  if (categories.length < 2) { showToast('至少需要两个同类型分类才能合并'); return; }
  const ordered = categories.filter(row => row.parentId == null).flatMap(parent => [parent, ...categories.filter(row => row.parentId === parent.id)]);
  function renderChoices(source?: Category): void {
    const choices = source ? ordered.filter(row => row.id !== source.id && (row.parentId == null) === (source.parentId == null)) : ordered;
    const events = new AbortController();
    openSheet({ ariaLabel: source ? '选择合并目标分类' : '选择原分类', onClose: () => events.abort(), render(el) {
      el.innerHTML = `${head(source ? '选择保留的目标分类' : '选择要合并的原分类')}
        <div class="sheet-scroll cm-merge-content">
          <p class="sub">${source ? `原分类：${esc(categoryPath(source, categories))}` : '先选原分类，再选要保留的分类。'}</p>
          <div class="card list">${choices.length ? choices.map(cat => `<button class="row cm-merge-choice" data-merge-category="${cat.id}">
            <span class="e-ic sm">${iconHtml(categoryIcon(cat, categories.find(row => row.id === cat.parentId)?.name), 18)}</span>
            <span>${esc(categoryPath(cat, categories))}</span><span class="chev">${iconHtml('ic-right', 15)}</span></button>`).join('') : '<p class="sub">没有同层级的目标分类，请先创建目标分类。</p>'}</div>
          ${source ? '<button class="btn ghost" data-merge-back>重新选择原分类</button>' : ''}
        </div>`;
      el.querySelector('[data-merge-close]')!.addEventListener('click', closeSheet, { signal: events.signal });
      el.querySelector('[data-merge-back]')?.addEventListener('click', () => renderChoices(), { signal: events.signal });
      let loading = false;
      el.querySelectorAll<HTMLButtonElement>('[data-merge-category]').forEach(button => button.addEventListener('click', () => {
        if (loading) return;
        const chosen = categories.find(row => row.id === Number(button.dataset.mergeCategory))!;
        if (!source) { renderChoices(chosen); return; }
        loading = true;
        button.disabled = true;
        void previewCategoryMerge(source.id, chosen.id).then(plan => {
          if (!events.signal.aborted) renderConfirmation(source, chosen, plan);
        }).catch(error => showToast(message(error))).finally(() => { loading = false; button.disabled = false; });
      }, { signal: events.signal }));
    } });
  }
  function renderConfirmation(source: Category, target: Category, plan: CategoryMergePreview): void {
    const events = new AbortController();
    openSheet({ ariaLabel: '确认合并分类', onClose: () => events.abort(), render(el) {
      el.innerHTML = `${head('确认合并分类')}<div class="sheet-scroll cm-merge-content">
        <div class="cm-merge-path"><span>移除原分类</span><strong>${esc(plan.sourcePath)}</strong><span>合并到并保留</span><strong>${esc(plan.targetPath)}</strong></div>
        <p>迁移 ${plan.entries - plan.deletedEntries} 笔有效账单、${plan.deletedEntries} 笔回收站账单。金额和账户余额不变。</p>
        ${plan.templates || plan.recurringRules ? `<p class="sub">同时更新 ${plan.templates} 个速记模板、${plan.recurringRules} 条周期规则及最近使用的分类。</p>` : ''}
        ${plan.children ? `<p class="sub">${plan.children} 个小类移入目标大类${plan.duplicateChildNames ? `，其中 ${plan.duplicateChildNames} 个名称与目标已有小类相同，不自动合并这些小类` : ''}。</p>` : ''}
        ${plan.categoryBudgets ? '<p class="sub">同月分类预算额度相加，月总预算不变。</p>' : ''}
        <p class="sub">合并前自动保留快照。7 天内可在「备份与恢复」整体撤销，届时会回滚快照之后的其他修改。</p>
        <p class="settings-status" data-merge-status role="status" aria-live="polite"></p>
        <div class="cm-merge-actions"><button class="btn ghost" data-merge-back>返回</button><button class="btn primary" data-merge-confirm>合并并移除原分类</button></div>
      </div>`;
      el.querySelector('[data-merge-close]')!.addEventListener('click', closeSheet, { signal: events.signal });
      el.querySelector('[data-merge-back]')!.addEventListener('click', () => renderChoices(source), { signal: events.signal });
      let busy = false;
      el.querySelector('[data-merge-confirm]')!.addEventListener('click', () => {
        if (busy) return;
        busy = true;
        const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')];
        buttons.forEach(button => button.disabled = true);
        const status = el.querySelector<HTMLElement>('[data-merge-status]')!;
        status.textContent = '正在保存恢复快照…';
        void (async () => {
          try {
            await createSnapshot('category-merge', `合并分类「${plan.sourcePath}」前`);
            if (events.signal.aborted) return;
            status.textContent = '正在合并分类…';
            await mergeCategories(source.id, target.id, plan.revision);
            if (!events.signal.aborted) closeSheet();
            showToast('分类已合并，账单金额与账户余额未改变');
          } catch (error) {
            if (!events.signal.aborted) {
              status.textContent = message(error);
              buttons.forEach(button => button.disabled = false);
              // A changed source/target must be previewed again before another commit.
              el.querySelector<HTMLButtonElement>('[data-merge-confirm]')!.disabled = true;
            }
            showToast(message(error));
          } finally { busy = false; }
        })();
      }, { signal: events.signal });
    } });
  }
  renderChoices();
}
