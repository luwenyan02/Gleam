import { describe, expect, it, vi } from 'vitest';
import type { Category } from '../src/core/types';
import { bindNoteCompletion, matchNoteCategoryId } from '../src/features/entry/entryNoteMatching';

const categories = ['早餐', '午餐', '晚餐', '饮料水果', '咖啡', '地铁', '打车', '住宿房租', '超市', '其他', '餐'].map((name, index) => ({
  id: index + 1, name, kind: 'expense', icon: 'ic-coin', sortOrder: index, createdAt: 1, updatedAt: 1,
}) as Category);

class NoteInput extends EventTarget {
  value = '';
  fire(name: string): void { this.dispatchEvent(new Event(name)); }
}

describe('备注本地分类匹配', () => {
  it.each([
    ['和同事吃午餐 28 元', '午餐'], ['下班吃晚饭', '晚餐'], ['今天打的回家', '打车'],
    ['买了奶茶', '饮料水果'], ['十月房租', '住宿房租'], ['买菜', '超市'], ['咖啡', '咖啡'],
  ])('完整备注 %s 匹配 %s', (note, name) => {
    expect(matchNoteCategoryId(categories, note)).toBe(categories.find(item => item.name === name)?.id);
  });

  it.each(['', '午', '餐', '今天花了30块', '其他消费', '午餐和晚餐', '晚饭后打车', '不是午餐', '可能是晚餐'])('%s 不明确时不猜分类', (note) => {
    expect(matchNoteCategoryId(categories, note)).toBeUndefined();
  });

  it('自定义分类可匹配完整名称，不匹配单字或英文单词片段', () => {
    const custom = [
      { ...categories[0], name: '羽毛球' },
      { ...categories[1], name: 'Bus' },
    ];
    expect(matchNoteCategoryId(custom, '周五羽毛球场地')).toBe(custom[0].id);
    expect(matchNoteCategoryId(custom, 'BUS ticket')).toBe(custom[1].id);
    expect(matchNoteCategoryId(custom, 'business trip')).toBeUndefined();
  });

  it('重复同名分类不任意选择；缺少目标分类时不匹配', () => {
    expect(matchNoteCategoryId([categories[1], { ...categories[1], id: 100 }], '午餐')).toBeUndefined();
    expect(matchNoteCategoryId([categories[0]], '奶茶')).toBeUndefined();
  });
});

describe('备注完成输入', () => {
  it('输入期间不匹配，离开输入框时同步使用最新完整内容', () => {
    const input = new NoteInput();
    const complete = vi.fn();
    bindNoteCompletion(input as unknown as HTMLInputElement, complete);
    input.fire('focus');
    input.value = '午'; input.fire('input');
    input.value = '午餐'; input.fire('input');
    expect(complete).not.toHaveBeenCalled();
    input.fire('blur');
    expect(complete).toHaveBeenCalledExactlyOnceWith('午餐');
  });

  it('IME 候选词不触发匹配，组合结束后的完整内容离焦才处理', () => {
    const input = new NoteInput();
    const complete = vi.fn();
    bindNoteCompletion(input as unknown as HTMLInputElement, complete);
    input.fire('focus'); input.fire('compositionstart');
    input.value = '午餐'; input.fire('input'); input.fire('compositionend');
    expect(complete).not.toHaveBeenCalled();
    input.value = '午餐和晚餐'; input.fire('blur');
    expect(complete).toHaveBeenCalledExactlyOnceWith('午餐和晚餐');
  });

  it('点击分类导致失焦时不抢先重绘按钮，取消手势也不永久锁住备注匹配', () => {
    const input = new NoteInput();
    const complete = vi.fn();
    let categoryIntent = true;
    bindNoteCompletion(input as unknown as HTMLInputElement, complete, () => !categoryIntent);
    input.fire('focus'); input.value = '午餐'; input.fire('blur');
    expect(complete).not.toHaveBeenCalled();
    categoryIntent = false;
    input.fire('focus'); input.fire('blur');
    expect(complete).toHaveBeenCalledExactlyOnceWith('午餐');
  });

  it('IME 期间点分类的失焦不在组合结束后补发旧备注', () => {
    const input = new NoteInput();
    const complete = vi.fn();
    let categoryIntent = true;
    bindNoteCompletion(input as unknown as HTMLInputElement, complete, () => !categoryIntent);
    input.fire('focus'); input.fire('compositionstart'); input.value = '午餐'; input.fire('blur');
    categoryIntent = false;
    input.fire('compositionend');
    expect(complete).not.toHaveBeenCalled();
  });

  it('IME 未提交前失焦也不读取半成品；关闭后没有延时或残留回调', () => {
    const input = new NoteInput();
    const complete = vi.fn();
    const dispose = bindNoteCompletion(input as unknown as HTMLInputElement, complete);
    input.fire('focus'); input.fire('compositionstart');
    input.value = 'wu'; input.fire('blur');
    expect(complete).not.toHaveBeenCalled();
    input.value = '午餐'; input.fire('compositionend');
    expect(complete).toHaveBeenCalledExactlyOnceWith('午餐');
    dispose();
    input.fire('focus'); input.value = '晚餐'; input.fire('blur'); input.fire('compositionend');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
