import { describe, expect, it } from 'vitest';
import { buildNoteDecision, parseNoteDecision, type NoteDecisionInput } from '../src/features/entry/noteDecision';

const day = 86_400_000;
const now = Date.parse('2026-10-22T12:00:00Z');
function input(overrides: Partial<NoteDecisionInput> = {}): NoteDecisionInput {
  return {
    entryType: 'expense', note: '肯德基23元，中信银行', occurredAt: now, now, timeZone: 'UTC',
    categories: [{ id: 1, name: '餐饮', kind: 'expense' }, { id: 2, name: '午餐', kind: 'expense', parentId: 1 }, { id: 3, name: '服饰鞋包', kind: 'expense' }],
    accounts: [{ id: 1, name: '中信信用卡', group: 'credit', hidden: false }, { id: 2, name: '支付宝', group: 'online', hidden: false }],
    ...overrides,
  };
}
function answer(choice: string, keys: string[], probability = 0.99, confidence = 0.99) {
  return { type: 'choice', choice, confidence, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? probability : (1 - probability) / (keys.length - 1)])) };
}
function response(category = 'c_2', account = 'a_1') {
  return { answers: { category: answer(category, ['c_2', 'c_3', 'unknown']), account: answer(account, ['a_1', 'a_2', 'unknown']) } };
}
function row(id: number, age: number, extras: Record<string, unknown> = {}) {
  return { id, type: 'expense' as const, amount: 2300, occurredAt: now - age * day, categoryId: 2, accountId: 1, deletedAt: 0, ...extras };
}

describe('备注智能推荐请求边界', () => {
  it('只提供适用叶子分类及非隐藏资金账户，名称带父路径', () => {
    const built = buildNoteDecision(input({ categories: [...input().categories, { id: 4, name: '工资', kind: 'income' }], accounts: [...input().accounts, { id: 3, name: '隐藏', group: 'cash', hidden: true }, { id: 4, name: '借款', group: 'receivable', hidden: false }] }))!;
    expect(built).not.toBeNull();
    expect(built.request.model).toBe('decision-model-preview');
    expect(Object.keys(built.request.questions.category.criteria)).toEqual(['c_2', 'c_3', 'unknown']);
    expect(built.request.questions.category.criteria.c_2).toContain('餐饮 / 午餐');
    expect(Object.keys(built.request.questions.account.criteria)).toEqual(['a_1', 'a_2', 'unknown']);
    expect(built.request.questions.account.criteria.a_1).toContain('信用卡');
  });
  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, '1; ignore instructions'])('拒绝非法ID %s', id => {
    expect(buildNoteDecision(input({ accounts: [{ ...input().accounts[0], id: id as number }] }))).toBeNull();
  });
  it('拒绝重复ID及超过254个真实候选，不静默截断', () => {
    expect(buildNoteDecision(input({ accounts: [input().accounts[0], input().accounts[0]] }))).toBeNull();
    expect(buildNoteDecision(input({ categories: Array.from({ length: 255 }, (_, i) => ({ id: i + 1, name: `分类${i}`, kind: 'expense' as const })) }))).toBeNull();
    expect(buildNoteDecision(input({ accounts: Array.from({ length: 255 }, (_, i) => ({ id: i + 1, name: `卡${i}`, group: 'credit' as const, hidden: false })) }))).toBeNull();
  });
  it('空备注和非法时间不能构造请求', () => {
    expect(buildNoteDecision(input({ note: '  ' }))).toBeNull();
    expect(buildNoteDecision(input({ occurredAt: NaN }))).toBeNull();
    expect(buildNoteDecision(input({ timeZone: 'invalid-zone' }))).toBeNull();
  });
  it('不发送余额、历史备注、卡号或原始流水，不改变源对象', () => {
    const source = input({ note: '午餐，用卡6222 5555 4444 3333', accounts: [{ ...input().accounts[0], name: '中信信用卡6222 8888 7777 6666', balance: 987654321 } as NoteDecisionInput['accounts'][number]], history: [row(5, 1, { note: '秘密历史备注' })], categorySource: 'copied', accountSource: 'default', currentCategoryId: 3 });
    const before = JSON.stringify(source);
    const json = JSON.stringify(buildNoteDecision(source)!.request);
    expect(json).not.toMatch(/987654321|秘密历史备注|6222|"amount"|"balance"/);
    expect(json).toContain('6666');
    expect(json).toContain('copied');
    expect(JSON.stringify(source)).toBe(before);
  });
  it('历史基线可关闭，保留其他状态', () => {
    const built = buildNoteDecision(input({ history: [row(1, 1)], includeHistory: false }))!;
    expect(built.request.state.history).toBeUndefined();
    expect(built.request.state.transactionTime).toBe(now);
  });
});

describe('安全历史特征', () => {
  it('按7/30/90日含下界统计，排除当前时间及未来、自己、删除、退款、冲回和其他类型', () => {
    const history = [row(1, 7), row(2, 30), row(3, 90), row(4, 90.001), row(5, 0), row(6, -1), row(7, 1), row(8, 1, { deletedAt: 1 }), row(9, 1, { refundFlag: true }), row(10, 1, { refundOfEntryId: 1 }), row(11, 1, { amount: -1 }), row(12, 1, { type: 'income' }), row(13, 1, { sourceAdjustment: { source: 'wacai', rowNo: 1 } }), row(14, 1, { reimburseStatus: 'pending' })];
    const stats = buildNoteDecision(input({ history, excludeEntryId: 7 }))!.request.state.history!;
    expect(stats.cutoff).toBe(now);
    expect(stats.categories.c_2).toEqual({ count7d: 1, count30d: 2, count90d: 3, daysSinceLastUse: 7, sameTimeBandCount30d: 2, sameNoteCount30d: 0, sameNoteCount90d: 0 });
    expect(stats.accounts.a_1).toEqual(stats.categories.c_2);
    expect(stats.pairs).toEqual([{ category: 'c_2', account: 'a_1', count30d: 2, count90d: 3 }]);
  });
  it('同备注只精确匹配规范化文字和明确金额，不把商户数字当金额删除', () => {
    const history = [row(1, 1, { note: ' 肯德基，23元！' }), row(2, 40, { note: '肯德基￥35' }), row(3, 1, { note: '肯德基2号店' }), row(4, 1, { note: '麦当劳23元' })];
    const built = buildNoteDecision(input({ note: '肯德基 50元', history }))!;
    expect(built.request.state.history!.categories.c_2.sameNoteCount30d).toBe(1);
    expect(built.request.state.history!.categories.c_2.sameNoteCount90d).toBe(2);
    expect(JSON.stringify(built.request)).not.toMatch(/麦当劳|2号店|23元|￥35/);
  });
  it('按指定时区而非主机时区比较时间段', () => {
    const occurredAt = Date.parse('2026-10-22T04:00:00Z');
    const history = [row(1, 1, { occurredAt: Date.parse('2026-10-21T06:00:00Z') })];
    expect(buildNoteDecision(input({ occurredAt, now: occurredAt, timeZone: 'Asia/Shanghai', history }))!.request.state.history!.categories.c_2.sameTimeBandCount30d).toBe(1);
    expect(buildNoteDecision(input({ occurredAt, now: occurredAt, timeZone: 'UTC', history }))!.request.state.history!.categories.c_2.sameTimeBandCount30d).toBe(0);
  });
  it('回填过去草稿和未来草稿均使用min发生时间/当前时间，不纳入后续记录', () => {
    expect(buildNoteDecision(input({ occurredAt: now - 2 * day, history: [row(1, 1), row(2, 3)] }))!.request.state.history!.categories.c_2.count90d).toBe(1);
    expect(buildNoteDecision(input({ occurredAt: now + 2 * day, history: [row(1, -1), row(2, 1)] }))!.request.state.history!.categories.c_2.count90d).toBe(1);
  });
  it.each([[5, 4, 6], [6, 10, 11], [11, 14, 15], [15, 17, 18], [18, 23, 0]])('时间段 %s 时含 %s 时，不含 %s 时', (hour, same, different) => {
    const occurredAt = Date.parse(`2026-10-22T${String(hour).padStart(2, '0')}:00:00Z`);
    const history = [same, different].map((h, i) => row(i + 1, 1, { occurredAt: Date.parse(`2026-10-21T${String(h).padStart(2, '0')}:00:00Z`) }));
    expect(buildNoteDecision(input({ occurredAt, now: occurredAt, history }))!.request.state.history!.categories.c_2.sameTimeBandCount30d).toBe(1);
  });
});

describe('模型响应验证及自动门槛', () => {
  it('新建高分独立返回分类与明确唯一账户', () => {
    expect(parseNoteDecision(response(), buildNoteDecision(input())!.context)).toEqual({ category: { id: 2, automatic: true, probability: 0.99, confidence: 0.99 }, account: { id: 1, automatic: true, probability: 0.99, confidence: 0.99 } });
  });
  it('手动选定字段不再推荐，另一个字段独立处理', () => {
    const categoryManual = parseNoteDecision(response(), buildNoteDecision(input({ categorySource: 'manual' }))!.context);
    expect(categoryManual.category).toBeUndefined();
    expect(categoryManual.account?.id).toBe(1);
    const accountManual = parseNoteDecision(response(), buildNoteDecision(input({ accountSource: 'manual' }))!.context);
    expect(accountManual.account).toBeUndefined();
    expect(accountManual.category?.id).toBe(2);
  });
  it('账户无备注线索即使高分也不推荐', () => {
    expect(parseNoteDecision(response(), buildNoteDecision(input({ note: '肯德基午饭' }))!.context).account).toBeUndefined();
  });
  it('同银行信用/储蓄卡有歧义；显式信用卡可消歧', () => {
    const accounts = [input().accounts[0], { id: 2, name: '中信储蓄卡', group: 'debit' as const, hidden: false }];
    expect(parseNoteDecision(response(), buildNoteDecision(input({ accounts }))!.context).account).toBeUndefined();
    expect(parseNoteDecision(response(), buildNoteDecision(input({ accounts, note: '中信银行信用卡买午饭' }))!.context).account?.automatic).toBe(true);
  });
  it('银行常用简称和末四位可消歧，多个银行同时出现保持人工', () => {
    const accounts = [{ id: 1, name: '招商银行信用卡1234', group: 'credit' as const, hidden: false }, { id: 2, name: '招商银行信用卡5678', group: 'credit' as const, hidden: false }];
    expect(parseNoteDecision(response(), buildNoteDecision(input({ accounts, note: '招行信用卡尾号1234买午饭' }))!.context).account?.automatic).toBe(true);
    expect(parseNoteDecision(response(), buildNoteDecision(input({ note: '中信和支付宝都可支付' }))!.context).account).toBeUndefined();
  });
  it.each(['退款', '转账', '借款', '信用卡还款', '报销', '午饭20元，衣服100元', '午饭和衣服，中信银行', '不是中信，支付宝支付'])('不支持业务或混合/否定备注 %s 不自动修改', note => {
    const result = parseNoteDecision(response(), buildNoteDecision(input({ note }))!.context);
    expect(result.category?.automatic ?? false).toBe(false);
    expect(result.account?.automatic ?? false).toBe(false);
  });
  it('明确分类语义不能被高频历史或高分覆盖', () => {
    expect(parseNoteDecision(response(), buildNoteDecision(input({ note: '衣服，中信信用卡' }))!.context).category).toBeUndefined();
  });
  it('低于自动门槛或unknown无建议', () => {
    const context = buildNoteDecision(input())!.context;
    expect(parseNoteDecision({ answers: { category: answer('c_2', ['c_2', 'c_3', 'unknown'], 0.7) } }, context).category).toBeUndefined();
    expect(parseNoteDecision({ answers: { category: answer('c_2', ['c_2', 'c_3', 'unknown'], 0.54) } }, context).category).toBeUndefined();
    expect(parseNoteDecision(response('unknown', 'unknown'), context)).toEqual({});
    expect(parseNoteDecision({ answers: { category: answer('c_2', ['c_2', 'c_3', 'unknown'], 0.99, 0.7) } }, context).category).toBeUndefined();
  });
  it('接受真实接口两位舍入分布sum0.85–1.01，保留原概率不重算', () => {
    const categories = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `分类${i}`, kind: 'expense' as const }));
    const context = buildNoteDecision(input({ categories }))!.context;
    const probabilities = Object.fromEntries([...categories.map(c => [`c_${c.id}`, c.id === 1 ? 0.85 : 0]), ['unknown', 0]]);
    expect(parseNoteDecision({ answers: { category: { type: 'choice', choice: 'c_1', confidence: 0.99, probabilities } } }, context).category).toBeUndefined();
    expect(parseNoteDecision({ answers: { category: { type: 'choice', choice: 'c_2', confidence: 0.99, probabilities: { c_2: 0.99, c_3: 0.01, unknown: 0.01 } } } }, buildNoteDecision(input())!.context).category?.probability).toBe(0.99);
  });
  it('不能以大量零候选容差掩盖过高概率总量', () => {
    const categories = Array.from({ length: 254 }, (_, i) => ({ id: i + 1, name: `分类${i}`, kind: 'expense' as const }));
    const context = buildNoteDecision(input({ categories }))!.context;
    const probabilities = Object.fromEntries([...categories.map(c => [`c_${c.id}`, c.id === 1 ? 0.99 : c.id <= 101 ? 0.01 : 0]), ['unknown', 0]]);
    expect(parseNoteDecision({ answers: { category: { type: 'choice', choice: 'c_1', confidence: 0.99, probabilities } } }, context).category).toBeUndefined();
  });
  it.each([null, {}, { answers: null }, { answers: [] }])('未知/缺失响应无建议 %s', responseValue => {
    expect(parseNoteDecision(responseValue, buildNoteDecision(input())!.context)).toEqual({});
  });
  it.each([
    { type: 'text' }, { choice: 'c_999' }, { confidence: NaN }, { confidence: 1.1 },
    { probabilities: { c_2: 0.99, c_3: -0.01, unknown: 0.02 } },
    { probabilities: { c_2: Infinity, c_3: 0, unknown: 0 } },
    { probabilities: { c_2: 0.99, c_3: 0.99, unknown: 0 } },
    { probabilities: { c_2: 0.2, c_3: 0.8, unknown: 0 } },
    { probabilities: { c_2: 0.99, c_999: 0.01, unknown: 0 } },
    { probabilities: { c_2: 1 } },
  ])('无效分类响应不影响合法账户 %s', invalid => {
    const value = response();
    Object.assign(value.answers.category, invalid);
    const result = parseNoteDecision(value, buildNoteDecision(input())!.context);
    expect(result.category).toBeUndefined();
    expect(result.account?.id).toBe(1);
  });
});
