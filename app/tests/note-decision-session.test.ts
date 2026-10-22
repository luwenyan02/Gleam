import { describe, expect, it, vi } from 'vitest';
import { NoteDecisionSession, type NoteDraftSnapshot } from '../src/features/entry/noteDecisionSession';

const suggested = { id: 2, automatic: true, probability: .99, confidence: .99 };
function fixture(copy = false) {
  let draft: NoteDraftSnapshot = { note: copy ? '旧备注' : '', type: 'expense', occurredAt: 123, categoryId: 1, accountId: 1 };
  let resolve!: (value: any) => void;
  const request = vi.fn((_draft: NoteDraftSnapshot, _signal: AbortSignal) => new Promise<any>(r => { resolve = r; }));
  const notify = vi.fn();
  const apply = vi.fn(patch => { draft = { ...draft, ...patch }; });
  const session = new NoteDecisionSession({ read: () => ({ ...draft }), request, apply, notify }, { category: copy ? 'copied' : 'default', account: copy ? 'copied' : 'default' });
  return { session, request, apply, notify, edit: (patch: Partial<NoteDraftSnapshot>) => { draft = { ...draft, ...patch }; }, get: () => draft, answer: (value: any) => resolve(value) };
}
describe('备注推荐会话', () => {
  it('初始/空备注/重复失焦不请求，完成新备注后才独立回填', async () => {
    const f = fixture(); await f.session.complete(); expect(f.request).not.toHaveBeenCalled();
    f.edit({ note: '午餐，中信信用卡' }); const task = f.session.complete();
    f.answer({ category: suggested }); await task;
    expect(f.get()).toMatchObject({ categoryId: 2, accountId: 1 });
    await f.session.complete(); expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('复制初值不请求，修改备注后可以替换复制分类与账户', async () => {
    const f = fixture(true); await f.session.complete(); expect(f.request).not.toHaveBeenCalled();
    f.edit({ note: '洗衣机，广发信用卡' }); const task = f.session.complete();
    f.answer({ category: suggested, account: suggested }); await task;
    expect(f.get()).toMatchObject({ categoryId: 2, accountId: 2 });
  });
  it('请求中手选后取消，迟到结果不覆盖手选，也不回填其他字段', async () => {
    const f = fixture(); f.edit({ note: '午餐' }); const task = f.session.complete();
    f.session.manual('account'); f.edit({ accountId: 3 });
    expect(f.request.mock.calls[0][1].aborted).toBe(true);
    f.answer({ category: suggested, account: suggested }); await task;
    expect(f.get()).toMatchObject({ categoryId: 1, accountId: 3 }); expect(f.apply).not.toHaveBeenCalled();
  });
  it('完成前已手选字段受保护，另一个字段可自动回填', async () => {
    const f = fixture(); f.session.manual('category'); f.edit({ categoryId: 3, note: '午餐' });
    const task = f.session.complete(); f.answer({ category: suggested, account: suggested }); await task;
    expect(f.get()).toMatchObject({ categoryId: 3, accountId: 2 });
  });
  it('歧义/低置信不回填、不展示建议', async () => {
    const f = fixture(); f.edit({ note: '中信银行' }); const task = f.session.complete();
    f.answer({ account: { ...suggested, automatic: false } }); await task;
    expect(f.apply).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenLastCalledWith([]);
  });
  it('撤销只还原模型改过且未被手选覆盖的字段，撤销后保护手选意图', async () => {
    const f = fixture(true); f.edit({ note: '新备注' }); const task = f.session.complete();
    f.answer({ category: suggested, account: suggested }); await task;
    f.session.manual('account'); f.edit({ accountId: 3 }); f.session.undo();
    expect(f.get()).toMatchObject({ categoryId: 1, accountId: 3 });
    await f.session.complete(); expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(['note', 'type', 'occurredAt', 'categoryId', 'accountId'] as const)('快照%s变化后迟到结果失效', async key => {
    const f = fixture(); f.edit({ note: '午餐' }); const task = f.session.complete();
    f.edit({ [key]: key === 'note' ? '晚餐' : key === 'type' ? 'income' : 456 });
    f.answer({ category: suggested, account: suggested }); await task; expect(f.apply).not.toHaveBeenCalled();
  });
  it('再记是新草稿：相同备注重新请求，上一笔手选保护不跨笔继承', async () => {
    const f = fixture(); f.edit({ note: '午餐' }); const first = f.session.complete();
    f.answer({ category: suggested }); await first;
    f.session.manual('category'); f.session.manual('account');
    f.edit({ note: '' }); f.session.repeat();
    f.edit({ note: '午餐' }); const second = f.session.complete();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[1]).toContainEqual({ category: 'copied', account: 'copied' });
    f.answer({ account: suggested }); await second;
    expect(f.get().accountId).toBe(2);
  });
  it('关闭、保存或新输入均可取消；异步失败不影响字段', async () => {
    for (const action of ['dispose', 'invalidate'] as const) {
      const f = fixture(); f.edit({ note: '午餐' }); const task = f.session.complete();
      f.session[action](); f.answer({ category: suggested }); await task; expect(f.apply).not.toHaveBeenCalled();
    }
    const f = fixture(); f.request.mockRejectedValueOnce(new Error('offline')); f.edit({ note: '午餐' });
    await f.session.complete(); expect(f.apply).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenLastCalledWith([]);
  });
});
