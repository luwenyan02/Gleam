import { iconHtml } from '../../assets/icons';
import { esc } from '../../core/esc';
import type { Category } from '../../core/types';

export function selectQuickCategories(
  categories: readonly Category[],
  selected?: Category,
  limit = 7,
): Category[] {
  if (!selected || categories.some((item) => item.id === selected.id)) return categories.slice(0, limit);
  return [selected, ...categories.filter((item) => item.id !== selected.id)].slice(0, limit);
}

export function renderCategoryButton(category: Category, selected: boolean): string {
  return `<button class="cat${selected ? ' sel' : ''}" data-id="${category.id}" type="button" role="option" aria-selected="${selected}">
    <span class="cat-ic">${iconHtml(category.icon)}</span><span>${esc(category.name)}</span></button>`;
}

export function renderCategoryToggle(expanded: boolean): string {
  return `<button class="cat cat-more" data-cat-more type="button" aria-expanded="${expanded}">
    <span class="cat-ic">${iconHtml(expanded ? 'ic-left' : 'ic-set')}</span><span>${expanded ? '收起' : '更多'}</span>
  </button>`;
}
