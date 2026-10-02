import type { Category } from '../../core/types';

/** 仅使用明确的本地词义；不联网、不从单字或笼统描述推断消费用途。 */
const CATEGORY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  早餐: ['早饭'], 午餐: ['午饭'], 晚餐: ['晚饭'],
  饮料水果: ['饮料', '水果', '奶茶', '果汁'],
  打车: ['打的', '出租车', '网约车'],
  停车费: ['停车'], 住宿房租: ['房租', '住宿', '租金'],
  水电燃气: ['水电费', '水费', '电费', '燃气费'],
  超市: ['买菜'], 服饰鞋包: ['衣服', '鞋子'],
  运动健身: ['健身'], 电影演出: ['电影', '演出'],
  医疗药品: ['买药', '药费', '挂号费'], 学习培训: ['培训费', '学费'],
};
const VAGUE_CATEGORY_NAMES = new Set(['其他', '其它', '日常', '消费', '杂项', '支出', '收入']);

function normalized(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase();
}

function includesTerm(text: string, term: string): boolean {
  if (term.length < 2) return false;
  // 英文分类必须完整成词，Bus 不匹配 business；中文分类保留自然短语匹配。
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = /^[a-z0-9]/i.test(term) ? '(?<![a-z0-9])' : '';
  const end = /[a-z0-9]$/i.test(term) ? '(?![a-z0-9])' : '';
  return new RegExp(`${start}${escaped}${end}`, 'iu').test(text);
}

/** 多个分类、否定/犹豫或没有明确命中时返回 undefined，由调用方保留原选择。 */
export function matchNoteCategoryId(categories: readonly Category[], note: string): number | undefined {
  const text = normalized(note);
  if (text.length < 2 || /不是|并非|不算|没买|没有买|可能|也许|不确定/.test(text)) return undefined;
  const matches = categories.filter(category => {
    const name = normalized(category.name);
    if (VAGUE_CATEGORY_NAMES.has(name)) return false;
    return [name, ...(CATEGORY_ALIASES[name] ?? [])].some(term => includesTerm(text, term));
  });
  return matches.length === 1 ? matches[0].id : undefined;
}

/** 同步在输入完成后处理；不设定时器，避免半句、IME 候选词或关闭后的旧任务改写草稿。 */
export function bindNoteCompletion(
  input: HTMLInputElement,
  onComplete: (note: string) => void,
  shouldComplete: (nextFocus: EventTarget | null) => boolean = () => true,
): () => void {
  let composing = false;
  let focused = false;
  let completeAfterComposition = false;
  const focus = () => { focused = true; completeAfterComposition = false; };
  const blur = (event: FocusEvent) => {
    focused = false;
    completeAfterComposition = shouldComplete(event.relatedTarget ?? null);
    if (!composing && completeAfterComposition) {
      completeAfterComposition = false;
      onComplete(input.value);
    }
  };
  const compositionStart = () => { composing = true; };
  const compositionEnd = () => {
    if (!composing) return;
    composing = false;
    if (!focused && completeAfterComposition) {
      completeAfterComposition = false;
      onComplete(input.value);
    }
  };
  input.addEventListener('focus', focus);
  input.addEventListener('blur', blur);
  input.addEventListener('compositionstart', compositionStart);
  input.addEventListener('compositionend', compositionEnd);
  return () => {
    input.removeEventListener('focus', focus);
    input.removeEventListener('blur', blur);
    input.removeEventListener('compositionstart', compositionStart);
    input.removeEventListener('compositionend', compositionEnd);
  };
}
