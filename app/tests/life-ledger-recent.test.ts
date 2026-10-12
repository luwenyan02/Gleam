import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import type { Entry } from '../src/core/types';
import { setSetting } from '../src/core/repo/settingsRepo';
import {
  approveLifeLedgerReview, assertLifeLedgerReviewFresh, consumeLifeLedgerGrant,
  getLifeLedgerEvidence, getLifeLedgerFollowUps, getLifeLedgerReview, isLifeLedgerQuestion,
  lifeLedgerReviewText, suggestLifeLedgerScope, type LifeLedgerScope,
} from '../src/core/repo/lifeLedgerContextRepo';

const question = '帮我总结和分一下近1个月的消费记录';
const at = (month: number, day: number) => new Date(2026, month - 1, day, 12).getTime();
const destination = { baseUrl: 'https://recent-ledger.invalid/v1', model: 'mock' };
const entry = (id: number, patch: Partial<Entry>): Entry => ({
  id, type: 'expense', amount: 10000, occurredAt: at(10, 12), categoryId: 1, accountId: 1,
  reimburseStatus: 'none', deletedAt: 0, createdAt: 1, updatedAt: 1, ...patch,
});

beforeEach(async () => {
  await db.delete(); await db.open();
  await db.categories.put({ id: 1, kind: 'expense', name: '餐饮', icon: '', sortOrder: 0, createdAt: 1, updatedAt: 1 });
});
afterEach(() => vi.restoreAllMocks());

describe('自然语言查询近期消费', () => {
  it.each([
    question, '帮我总结并分析近一个月的消费记录', '总结最近一个月的消费',
    '整理过去一个月的支出', '近30天花了多少钱？', '帮我分析最近三十天的消费',
    '请总结本月开销', '帮我读取我的记账数据并分析消费',
  ])('识别本人账本查询：%s', text => expect(isLifeLedgerQuestion(text)).toBe(true));

  it.each([
    '总结这篇文章：近1个月消费多少？', '请翻译近一个月花了多少钱',
    '我最近一个月消费很多，有点担心', '总结我的消费观', '分析怎么降低近一个月的消费',
    '帮我总结如何减少近一个月的开支', '请整理如何统计我的消费',
  ])('普通聊天和文本处理不读取账本：%s', text => expect(isLifeLedgerQuestion(text)).toBe(false));

  it.each(['近1个月', '近一个月', '近1月', '最近一个月', '过去一个月', '近30天', '最近三十天'])('建议近30天而非本月或一月份：%s', async period => {
    expect(await suggestLifeLedgerScope(`帮我总结${period}消费`, at(10, 12))).toEqual({
      month: '2026-10', period: 'recent', endDate: '2026-10-12', includeIncome: false,
    });
  });
});

describe('最近30个本地自然日的只读摘要', () => {
  const recentScope = async () => suggestLifeLedgerScope(question, at(10, 12));

  it('跨月边界、退款、报销与分类守恒；明细仍留在本机', async () => {
    const from = new Date(2026, 8, 13).getTime(), to = new Date(2026, 9, 13).getTime();
    await db.entries.bulkPut([
      entry(1, { occurredAt: from, amount: 10001, note: '私人备注', merchantId: 99 }),
      entry(2, { amount: 2000, refundFlag: true }),
      entry(3, { amount: 5000, reimburseStatus: 'done', reimbursedAmount: 3000, reimbursedAt: at(11, 1), reimburseAccountId: 1 }),
      entry(4, { occurredAt: to - 1, amount: 4000 }),
      entry(5, { occurredAt: from - 1, amount: 88888 }), entry(6, { occurredAt: to, amount: 99999 }),
      entry(7, { type: 'income', amount: 80000 }), entry(8, { type: 'transfer', amount: 900000 }),
      entry(9, { type: 'loan', amount: 700000 }), entry(10, { deletedAt: 1, amount: 77777 }),
    ]);
    const original = await db.entries.toArray();
    const review = await getLifeLedgerReview(question, await recentScope());
    expect(review.summary.range).toEqual({ from, to, label: '2026/9/13 – 2026/10/12' });
    expect(review.summary.totals).toEqual({ expenseFen: 14001, grossExpenseFen: 19001,
      refundFen: 2000, reimbursementOffsetFen: 3000, expenseCount: 3, refundCount: 1 });
    expect(review.summary.categories).toEqual([{ name: '餐饮', expenseFen: 14001, count: 4 }]);
    expect(lifeLedgerReviewText(review)).toContain('近30天');
    expect(lifeLedgerReviewText(review)).not.toContain('其他月份');
    for (const forbidden of ['私人备注', 'merchantId', 'accountId', 'entryId', ':88888', ':99999', ':80000', ':900000', ':700000', ':77777']) {
      expect(JSON.stringify(review)).not.toContain(forbidden);
    }
    const evidence = await getLifeLedgerEvidence(review, { month: '2026-10', type: 'expense', categoryIndex: 0 });
    expect(evidence.items.map(item => item.id).sort()).toEqual([1, 2, 3, 4]);
    expect(evidence.label).toContain('近30天');
    expect(await db.entries.toArray()).toEqual(original);
  });

  it('收入选项按到账日包含跨范围报销；默认不附带收入', async () => {
    await setSetting('reimburse.countAsIncome', true);
    await db.entries.bulkPut([
      entry(1, { occurredAt: at(8, 1), reimburseStatus: 'done', reimbursedAmount: 3000, reimbursedAt: at(9, 13), reimburseAccountId: 1 }),
      entry(2, { amount: 5000 }), entry(3, { type: 'income', amount: 90000 }),
    ]);
    const scope = await recentScope();
    expect((await getLifeLedgerReview(question, scope)).summary.income).toBeUndefined();
    const review = await getLifeLedgerReview(question, { ...scope, includeIncome: true });
    expect(review.summary.income).toEqual({ incomeFen: 93000, reimbursementIncomeFen: 3000, count: 2 });
    expect(review.summary.totals.expenseFen).toBe(5000);
  });

  it('跨年、闰年及夏令时以自然日计算，午夜之后仍绑定已确认日期', async () => {
    for (const [now, endDate, y, m, d] of [
      [at(1, 2), '2026-01-02', 2025, 11, 4],
      [new Date(2024, 2, 1, 12).getTime(), '2024-03-01', 2024, 1, 1],
      [at(3, 15), '2026-03-15', 2026, 1, 14],
      [at(11, 5), '2026-11-05', 2026, 9, 7],
    ] as const) {
      const scope = await suggestLifeLedgerScope(question, now);
      expect(scope.endDate).toBe(endDate);
      const review = await getLifeLedgerReview(question, scope);
      expect(review.summary.range.from).toBe(new Date(y, m, d).getTime());
      expect(new Date(review.summary.range.to).getHours()).toBe(0);
      vi.spyOn(Date, 'now').mockReturnValue(now + 86400000);
      await expect(assertLifeLedgerReviewFresh(review)).resolves.toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it.each([
    { endDate: undefined }, { endDate: '2026-02-30', month: '2026-02' },
    { endDate: '2026-10-12', month: '2026-09' }, { endDate: '0099-10-12', month: '0099-10' },
    { analysis: 'compare' }, { analysis: 'trend' }, { period: 'calendar' },
  ])('拒绝无效日期或混合范围：%s', async patch => {
    await expect(getLifeLedgerReview(question, { ...await recentScope(), ...patch } as LifeLedgerScope)).rejects.toThrow('有效的账本范围');
  });

  it('一次性授权验证范围内的数据变化；范围外变更不扩大范围', async () => {
    await db.entries.bulkPut([entry(1, {}), entry(2, { occurredAt: at(8, 1) })]);
    const review = await getLifeLedgerReview(question, await recentScope());
    const grant = approveLifeLedgerReview(review, destination);
    await db.entries.update(2, { amount: 1 });
    await expect(consumeLifeLedgerGrant(grant, question, destination)).resolves.toMatchObject(review);
    await expect(consumeLifeLedgerGrant(grant, question, destination)).rejects.toThrow('重新确认');
    await db.entries.update(1, { occurredAt: at(9, 14) });
    await expect(assertLifeLedgerReviewFresh(review)).rejects.toThrow('重新确认');
  });

  it('继续分析切换到明确的月度范围，不把近30天伪装成整月', async () => {
    const review = await getLifeLedgerReview(question, await recentScope());
    const options = getLifeLedgerFollowUps(review);
    expect(options.map(option => option.label)).toEqual(['查看本月', '对比上月', '近6个月趋势']);
    expect(options.every(option => option.scope.period === 'calendar' && option.scope.month === '2026-10' && !option.scope.endDate)).toBe(true);
  });
});
