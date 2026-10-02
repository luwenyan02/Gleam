import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import type { Entry } from '../src/core/types';
import { setSetting } from '../src/core/repo/settingsRepo';
import { secretStore } from '../src/core/secretStore';
import { continueLifeChat } from '../src/core/repo/lifeAiRepo';
import { approveLifeLedgerReview, getLifeLedgerReview, isLifeLedgerQuestion, suggestLifeLedgerScope } from '../src/core/repo/lifeLedgerContextRepo';
import { claimLegacyLifeChatDraft, getLifeDraft, migrateLifeDraft, putLifeDraft, saveLifeDraft } from '../src/core/repo/lifeDraftRepo';
import { exportAll, restoreAll, sanitizeDumpForBackup } from '../src/core/repo/backupRepo';
import { buildSkbak, parseSkbak } from '../src/features/backup/skbak';

const destination = { baseUrl: 'https://ledger-test.invalid/v1', model: 'mock-model' };
const question = '帮我分析一下我这个月的消费情况。';
const scope = { month: '2026-09', period: 'calendar' as const, includeIncome: false };
const at = (month: number, day = 10) => new Date(2026, month - 1, day, 12).getTime();
const entry = (id: number, patch: Partial<Entry>): Entry => ({
  id, type: 'expense', amount: 10000, occurredAt: at(9), categoryId: 1, accountId: 1,
  reimburseStatus: 'none', deletedAt: 0, createdAt: 1, updatedAt: 1, ...patch,
});

beforeEach(async () => {
  await db.delete(); await db.open();
  await setSetting('ai.baseUrl', destination.baseUrl);
  await setSetting('ai.model', destination.model);
  await setSetting('life.aiEnabled', true);
  await secretStore.set('ai.apiKey', 'synthetic-only-key');
  await db.categories.bulkPut([
    { id: 1, kind: 'expense', name: '餐饮', icon: '', sortOrder: 0, createdAt: 1, updatedAt: 1 },
    { id: 2, kind: 'expense', name: '午餐', parentId: 1, icon: '', sortOrder: 1, createdAt: 1, updatedAt: 1 },
  ]);
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await secretStore.remove('ai.apiKey'); });

describe('只读账本摘要', () => {
  it('自然语言入口保留明确月份，默认自然月，财务月需要明确选择', async () => {
    expect(isLifeLedgerQuestion(question)).toBe(true);
    expect(isLifeLedgerQuestion('这月花了多少钱？')).toBe(true);
    expect(isLifeLedgerQuestion('帮我看看2026年8月的支出')).toBe(true);
    expect(isLifeLedgerQuestion('帮我润色这段话')).toBe(false);
    expect(await suggestLifeLedgerScope('分析2026年8月消费', at(9))).toEqual({ ...scope, month: '2026-08' });
    expect(await suggestLifeLedgerScope('分析上个月消费', at(1))).toEqual({ ...scope, month: '2025-12' });
    await setSetting('accounting.monthStartDay', 20);
    expect(await suggestLifeLedgerScope(question, at(9))).toEqual(scope);
    expect(await suggestLifeLedgerScope('分析本财务月收支', at(9))).toEqual({ month: '2026-08', period: 'accounting', includeIncome: true });
  });

  it('整数分汇总大类、退款和报销冲抵；不泄露原始账目、账户、商家、备注或回收站', async () => {
    await db.entries.bulkPut([
      entry(1, { amount: 10001, categoryId: 2, note: '绝不发送的备注', merchantId: 99 }),
      entry(2, { amount: 2000, refundFlag: true }),
      entry(3, { amount: 5000, reimburseStatus: 'done', reimbursedAmount: 3000, reimbursedAt: at(10), reimburseAccountId: 1 }),
      entry(4, { type: 'income', amount: 80000 }),
      entry(5, { type: 'transfer', amount: 900000 }),
      entry(6, { type: 'loan', amount: 700000, loanKind: 'borrow' }),
      entry(7, { amount: 77777, deletedAt: 1 }),
      entry(8, { amount: 88888, occurredAt: at(8) }),
    ]);
    const review = await getLifeLedgerReview(question, scope);
    expect(review.summary.totals).toEqual({ expenseFen: 10001, grossExpenseFen: 15001, refundFen: 2000, reimbursementOffsetFen: 3000, expenseCount: 2, refundCount: 1 });
    expect(review.summary.categories).toEqual([{ name: '餐饮', expenseFen: 10001, count: 3 }]);
    const serialized = JSON.stringify(review);
    for (const secret of ['绝不发送', 'merchantId', 'accountId', 'balance', ':80000,', ':900000,', ':700000,', ':77777,', ':88888,']) expect(serialized).not.toContain(secret);
    expect(await db.entries.count()).toBe(8);
  });

  it('计收入模式按到账时间纳入跨月报销，默认仍不附带收入', async () => {
    await setSetting('reimburse.countAsIncome', true);
    await db.entries.bulkPut([
      entry(1, { amount: 5000, occurredAt: at(8), reimburseStatus: 'done', reimbursedAmount: 3000, reimbursedAt: at(9), reimburseAccountId: 1 }),
      entry(2, { amount: 10000 }), entry(3, { type: 'income', amount: 90000 }),
    ]);
    const review = await getLifeLedgerReview(question, scope);
    expect(review.summary.totals.expenseFen).toBe(10000);
    expect(review.summary.income).toBeUndefined();
    const withIncome = await getLifeLedgerReview('分析收支', { ...scope, includeIncome: true });
    expect(withIncome.summary.income).toEqual({ incomeFen: 93000, reimbursementIncomeFen: 3000, count: 2 });
  });

  it('空月保留零值；财务月和自然月遵守各自边界', async () => {
    await setSetting('accounting.monthStartDay', 20);
    await db.entries.bulkPut([entry(1, { occurredAt: at(9, 19) }), entry(2, { occurredAt: at(10, 1), amount: 20000 })]);
    expect((await getLifeLedgerReview(question, scope)).summary.totals.expenseFen).toBe(10000);
    expect((await getLifeLedgerReview(question, { ...scope, period: 'accounting' })).summary.totals.expenseFen).toBe(20000);
    expect((await getLifeLedgerReview(question, { ...scope, month: '2026-07' })).summary.totals.expenseCount).toBe(0);
  });

  it('按设备本地时间取 [月初, 下月初)，退款和跨月报销不越界', async () => {
    const from = new Date(2026, 8, 1).getTime(), to = new Date(2026, 9, 1).getTime();
    await setSetting('reimburse.countAsIncome', true);
    await db.entries.bulkPut([
      entry(1, { occurredAt: from, amount: 10001 }),
      entry(2, { occurredAt: from - 1, amount: 88888 }),
      entry(3, { occurredAt: to - 1, amount: 1000, refundFlag: true }),
      entry(4, { occurredAt: to, amount: 99999, refundFlag: true }),
      entry(5, { occurredAt: at(8), reimburseStatus: 'done', reimbursedAmount: 321, reimbursedAt: from, reimburseAccountId: 1 }),
      entry(6, { occurredAt: at(8), reimburseStatus: 'done', reimbursedAmount: 777, reimbursedAt: to, reimburseAccountId: 1 }),
    ]);
    const { summary } = await getLifeLedgerReview(question, { ...scope, includeIncome: true });
    expect(summary.range).toMatchObject({ from, to });
    expect(summary.totals.expenseFen).toBe(9001);
    expect(summary.income?.reimbursementIncomeFen).toBe(321);
  });

  it('大账本合并多余分类但不丢总额，限制自定义分类名长度', async () => {
    await db.categories.bulkPut(Array.from({ length: 20 }, (_, i) => ({ id: i + 10, kind: 'expense' as const, name: `${i}长分类${'长'.repeat(1000)}`, icon: '', sortOrder: i, createdAt: 1, updatedAt: 1 })));
    await db.entries.bulkPut(Array.from({ length: 2000 }, (_, i) => entry(i + 1, { categoryId: 10 + i % 20, amount: 101 })));
    const review = await getLifeLedgerReview(question, scope);
    expect(review.summary.categories).toHaveLength(13);
    expect(review.summary.categories.at(-1)?.name).toBe('其他分类（合并）');
    expect(review.summary.categories.reduce((sum, row) => sum + row.expenseFen, 0)).toBe(202000);
    expect(review.summary.categories.reduce((sum, row) => sum + row.count, 0)).toBe(2000);
    expect(review.summary.categories.every(row => row.name.length <= 80)).toBe(true);
    expect(JSON.stringify(review).length).toBeLessThan(3000);
  });

  it('备份、恢复、草稿迁移和保存正式记录都保留账本分析隐私标记', async () => {
    const draft = migrateLifeDraft({ key: 'chat:ledger', title: '', body: '', occurredAt: at(9), photos: [], existingPhotoRefs: [], aiExcluded: false,
      messages: [{ role: 'user', content: question, ledgerAnalysis: true }, { role: 'assistant', content: '虚构消费分析', ledgerAnalysis: true }],
    });
    await putLifeDraft(draft);
    const noteId = await saveLifeDraft(draft.key);
    expect((await db.lifeNotes.get(noteId))?.conversation?.every(message => message.ledgerAnalysis)).toBe(true);
    await putLifeDraft({ ...draft, key: 'chat:another' });
    const parsed = await parseSkbak(await (await buildSkbak(sanitizeDumpForBackup(await exportAll()))).arrayBuffer());
    await restoreAll(parsed.dump);
    expect((await getLifeDraft('chat:another'))?.messages.every(message => message.ledgerAnalysis)).toBe(true);
    expect((await db.lifeNotes.get(noteId))?.conversation?.every(message => message.ledgerAnalysis)).toBe(true);
    expect(() => migrateLifeDraft({ ...draft, messages: [{ role: 'user', content: question, ledgerAnalysis: 'yes' }] })).toThrow('标记');
  });

  it('相同文本的旧版无标记草稿不能在去重或保存时抹掉财务隐私标记', async () => {
    const draft = migrateLifeDraft({ key: 'chat:ledger', title: '', body: '', occurredAt: at(9), photos: [], existingPhotoRefs: [], aiExcluded: false,
      messages: [{ role: 'user', content: question, ledgerAnalysis: true }, { role: 'assistant', content: '虚构消费分析', ledgerAnalysis: true }],
    });
    await putLifeDraft(draft);
    const unmarked = draft.messages.map(({ ledgerAnalysis: _marker, ...message }) => message);
    await putLifeDraft({ ...draft, key: 'legacy', messages: [...unmarked, { role: 'user', content: '多一句历史文本' }] });
    const claimed = await claimLegacyLifeChatDraft(draft.key, ['legacy']);
    expect(claimed?.messages).toHaveLength(3);
    expect(claimed?.messages.slice(0, 2).every(message => message.ledgerAnalysis)).toBe(true);
    const noteId = await saveLifeDraft(draft.key);
    const existing = (await db.lifeNotes.get(noteId))!;
    await putLifeDraft({ ...draft, key: 'chat:edit', noteId, messages: existing.conversation!.map(({ ledgerAnalysis: _marker, ...message }) => message) });
    await saveLifeDraft('chat:edit');
    expect((await db.lifeNotes.get(noteId))?.conversation?.slice(0, 2).every(message => message.ledgerAnalysis)).toBe(true);
    expect((await db.lifeNotes.get(noteId))?.conversation).toHaveLength(3);
  });
});

describe('账本出站必须绑定本次确认', () => {
  function mockProvider() {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: '虚构分析', readyToSummarize: false }) } }] }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const messages = () => [{ role: 'user' as const, content: question }];

  it('仅发送已审阅摘要和当前问题，不带历史、照片或内部授权对象；授权用完即失效', async () => {
    await db.entries.put(entry(1, { amount: 12345 }));
    const review = await getLifeLedgerReview(question, scope);
    const ledgerGrant = approveLifeLedgerReview(review, destination);
    const fetchMock = mockProvider();
    const input = { body: '', messages: [{ role: 'user' as const, content: '历史私密消息' }, ...messages()], ledgerGrant, expectedDestination: destination };
    await expect(continueLifeChat(input)).resolves.toMatchObject({ reply: '虚构分析' });
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]!.body));
    expect(sent.messages).toHaveLength(2);
    expect(JSON.stringify(sent)).toContain('12345');
    expect(JSON.stringify(sent)).not.toContain('历史私密消息');
    expect(JSON.stringify(sent)).not.toContain('ledgerGrant');
    await expect(continueLifeChat(input)).rejects.toThrow('重新确认');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('问题、接口或账本摘要变化都必须重新确认；伪造 grant 不能发送', async () => {
    await db.entries.put(entry(1, {}));
    const review = await getLifeLedgerReview(question, scope);
    const fetchMock = mockProvider();
    await expect(continueLifeChat({ body: '', messages: messages(), expectedDestination: destination, ledgerGrant: {} as never })).rejects.toThrow('重新确认');
    await expect(continueLifeChat({ body: '', messages: [{ role: 'user', content: '换了问题' }], expectedDestination: destination, ledgerGrant: approveLifeLedgerReview(review, destination) })).rejects.toThrow('重新确认');
    await expect(continueLifeChat({ body: '', messages: messages(), expectedDestination: { ...destination, model: 'other' }, ledgerGrant: approveLifeLedgerReview(review, destination) })).rejects.toThrow('重新确认');
    await db.entries.update(1, { amount: 999 });
    await expect(continueLifeChat({ body: '', messages: messages(), expectedDestination: destination, ledgerGrant: approveLifeLedgerReview(review, destination) })).rejects.toThrow('重新确认');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('财务月规则、报销口径或当前实际提供方变化都使授权失效', async () => {
    await db.entries.put(entry(1, {}));
    const accounting = await getLifeLedgerReview(question, { ...scope, period: 'accounting' });
    const review = await getLifeLedgerReview(question, scope);
    const fetchMock = mockProvider();
    await setSetting('accounting.monthStartDay', 20);
    await expect(continueLifeChat({ body: '', messages: messages(), expectedDestination: destination, ledgerGrant: approveLifeLedgerReview(accounting, destination) })).rejects.toThrow('重新确认');
    await setSetting('reimburse.countAsIncome', true);
    await expect(continueLifeChat({ body: '', messages: messages(), expectedDestination: destination, ledgerGrant: approveLifeLedgerReview(review, destination) })).rejects.toThrow('重新确认');
    const fresh = await getLifeLedgerReview(question, scope);
    await setSetting('ai.baseUrl', 'https://other.invalid/v1');
    await expect(continueLifeChat({ body: '', messages: messages(), expectedDestination: destination, ledgerGrant: approveLifeLedgerReview(fresh, destination) })).rejects.toThrow('配置已变化');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('分数金额、整数溢出和未经确认附加的照片在出站前拒绝', async () => {
    await db.entries.put(entry(1, {}));
    const review = await getLifeLedgerReview(question, scope);
    const fetchMock = mockProvider();
    const request = () => continueLifeChat({ body: '', messages: messages(), expectedDestination: destination, ledgerGrant: approveLifeLedgerReview(review, destination) });
    await db.entries.update(1, { amount: 100.5 });
    await expect(request()).rejects.toThrow('安全范围');
    await db.entries.bulkPut([entry(1, { amount: Number.MAX_SAFE_INTEGER }), entry(2, { amount: 1 })]);
    await expect(request()).rejects.toThrow('安全范围');
    await db.entries.clear(); await db.entries.put(entry(1, {}));
    await expect(continueLifeChat({ body: '', messages: messages(), photos: ['data:image/png;base64,AQ=='], expectedDestination: destination, ledgerGrant: approveLifeLedgerReview(review, destination) })).rejects.toThrow('只发送');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('停止和网络失败不自动发出请求或复用旧授权', async () => {
    const review = await getLifeLedgerReview(question, scope);
    const fetchMock = mockProvider();
    const controller = new AbortController(); controller.abort();
    const aborted = { body: '', messages: messages(), expectedDestination: destination, ledgerGrant: approveLifeLedgerReview(review, destination) };
    await expect(continueLifeChat({ ...aborted, signal: controller.signal })).rejects.toThrow('取消');
    await expect(continueLifeChat(aborted)).rejects.toThrow('重新确认');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    const input = { body: '', messages: messages(), expectedDestination: destination, ledgerGrant: approveLifeLedgerReview(review, destination) };
    await expect(continueLifeChat(input)).rejects.toThrow('不可用');
    await expect(continueLifeChat(input)).rejects.toThrow('重新确认');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
