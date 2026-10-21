import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import type { LifeDraft } from '../src/core/types';
import type { LifeLedgerReview, LifeLedgerSummary } from '../src/core/repo/lifeLedgerContextRepo';
import { isLifeLedgerQuestion } from '../src/core/repo/lifeLedgerContextRepo';
import { ledgerChatChart } from '../src/core/lifeChatChart';
import { getLifeDraft, putLifeDraft, saveLifeDraft } from '../src/core/repo/lifeDraftRepo';
import { addAttachment, addLifeNote, getLifeNote, purgeLifeNote, softDeleteLifeNote } from '../src/core/repo/lifeRepo';
import { collectUnreferencedAttachments } from '../src/core/repo/entryAttachmentRepo';
import { exportAll, restoreAll } from '../src/core/repo/backupRepo';
import { buildSkbak, parseSkbak } from '../src/features/backup/skbak';

const summary = (month: string, expense = 12345, income = 23456): LifeLedgerSummary => ({
  scope: { month, period: 'calendar', includeIncome: true }, range: { from: 1, to: 2, label: month },
  currency: 'CNY', unit: 'fen', reimbursementMode: 'offset',
  totals: { expenseFen: expense, grossExpenseFen: expense, refundFen: 0, reimbursementOffsetFen: 0, expenseCount: 1, refundCount: 0 },
  categories: [{ name: '虚构餐饮', expenseFen: expense, count: 1 }], income: { incomeFen: income, reimbursementIncomeFen: 0, count: 1 },
});
beforeEach(async () => { await db.delete(); await db.open(); });

it('账本绘图意图仍走确认，方法咨询不读取账本', () => {
  expect(isLifeLedgerQuestion('把我最近六个月的收支画成柱状图')).toBe(true);
  expect(isLifeLedgerQuestion('画一下我的本月支出分类环形图')).toBe(true);
  expect(isLifeLedgerQuestion('怎么用代码画我的收支图表？')).toBe(false);
  expect(isLifeLedgerQuestion('我昨天画了我的本月支出图')).toBe(false);
});

it('图表仅使用确认的本机金额快照，保留整数分和收入范围', () => {
  const current = summary('2026-10');
  current.analysis = { kind: 'trend', periods: [summary('2026-09', -1200, 67890), summary('2026-10')],
    change: { expenseChangeFen: 13545, expenseChangePercent: null, reason: 'negative-baseline' } };
  const review: LifeLedgerReview = { question: '把我最近六个月收支画成折线图', summary: current };
  const before = structuredClone(review);
  expect(ledgerChatChart(review)).toMatchObject({ type: 'line', valueDivisor: 100, unit: '元', labels: ['2026-09', '2026-10'],
    series: [{ name: '净支出', values: [-1200, 12345] }, { name: '收入', values: [67890, 23456] }] });
  expect(review).toEqual(before);
  expect(ledgerChatChart({ ...review, question: '帮我分析收支' })).toBeUndefined();
  delete current.analysis; delete current.income; current.scope.includeIncome = false;
  expect(ledgerChatChart(review)?.series).toEqual([{ name: '净支出', values: [12345] }]);
  current.scope.period = 'recent'; current.scope.endDate = '2026-10-21'; review.question = '画近30天收支图';
  expect(ledgerChatChart(review)?.labels).toEqual(['近30天']);
});

it('负分类或全零时不伪造环形比例，分类超限聚合且金额不丢失', () => {
  const data = summary('2026-10');
  data.categories = [{ name: '退款', expenseFen: -100, count: 1 }, { name: '饮食', expenseFen: 300, count: 1 }];
  const review = { question: '画我的本月支出环形图', summary: data };
  expect(ledgerChatChart(review)?.type).toBe('bar');
  data.categories = Array.from({ length: 30 }, (_, i) => ({ name: `虚构分类${i}`, expenseFen: i, count: 1 }));
  const chart = ledgerChatChart(review)!;
  expect(chart.labels).toHaveLength(24);
  expect(chart.labels.at(-1)).toBe('其他');
  expect(chart.series[0].values.reduce((a, b) => a + b, 0)).toBe(435);
});

it('本机长分类和换行只影响展示标签，不阻断完整回复或改动原分类', () => {
  const data = summary('2026-10');
  const name = '虚构长分类'.repeat(16) + '\n结束';
  data.categories = [{ name, expenseFen: 12345, count: 1 }];
  const chart = ledgerChatChart({ question: '画我的本月支出图表', summary: data });
  expect(chart?.labels[0].length).toBeLessThanOrEqual(48);
  expect(chart?.series[0].values).toEqual([12345]);
  expect(data.categories[0].name).toBe(name);
});

it('图表在草稿、正式会话、加密包恢复后保留且不改账本', async () => {
  const chart = ledgerChatChart({ question: '画我的本月支出柱状图', summary: summary('2026-10') })!;
  const draft: LifeDraft = { key: 'chat:new', title: '虚构图表记录', body: '', occurredAt: 1, photos: [], existingPhotoRefs: [], aiExcluded: false,
    messages: [{ role: 'user', content: '虚构绘图请求' }, { role: 'assistant', content: '本机图表', chart, ledgerAnalysis: true }] };
  await putLifeDraft(draft);
  expect((await getLifeDraft(draft.key))?.messages[1].chart).toEqual(chart);
  const id = await saveLifeDraft(draft.key);
  expect((await getLifeNote(id))?.conversation?.[1].chart).toEqual(chart);
  const built = await buildSkbak(await exportAll(), 'fictional-chart-backup');
  const parsed = await parseSkbak(await built.arrayBuffer(), 'fictional-chart-backup');
  await restoreAll(parsed.dump);
  expect((await getLifeNote(id))?.conversation?.[1].chart).toEqual(chart);
  expect(await db.entries.count()).toBe(0);
  expect(await db.accounts.count()).toBe(0);
  for (const invalid of [{ ...chart, labels: [] }, { ...chart, version: 99 }]) {
    const tampered = structuredClone(await exportAll());
    (tampered.lifeNotes[0] as { conversation: Array<{ chart?: unknown }> }).conversation[1].chart = invalid;
    const damaged = await buildSkbak(tampered);
    await expect(parseSkbak(await damaged.arrayBuffer())).rejects.toThrow('对话图表损坏');
  }
});

it('拒绝用户消息夹带图表及损坏图表，不能污染已保存草稿', async () => {
  const chart = ledgerChatChart({ question: '画我的本月支出图表', summary: summary('2026-10') })!;
  const draft: LifeDraft = { key: 'chat:new', title: '', body: '', occurredAt: 1, photos: [], existingPhotoRefs: [], aiExcluded: false,
    messages: [{ role: 'assistant', content: '虚构回复', chart }] };
  await putLifeDraft(draft);
  for (const patch of [{ role: 'user' }, { chart: { ...chart, series: [{ name: '错长', values: [] }] } }]) {
    await expect(putLifeDraft({ ...draft, messages: [{ ...draft.messages[0], ...patch } as never] })).rejects.toThrow('图表');
  }
  expect((await getLifeDraft(draft.key))?.messages[0].chart).toEqual(chart);
});

it('旧会话独有的图片引用仍受回收保护，永久删除最后引用后释放', async () => {
  const ref = await addAttachment(new Blob(['synthetic'], { type: 'image/png' }));
  const id = await addLifeNote({ kind: 'diary', body: '虚构会话', occurredAt: 1,
    conversation: [{ role: 'assistant', content: '虚构附件', photoRefs: [ref] }] });
  await db.transaction('rw', [db.lifeNotes, db.lifeDrafts, db.lifeEditions, db.settings, db.entryAttachments, db.attachments], () => collectUnreferencedAttachments([ref]));
  expect(await db.attachments.get(ref)).toBeDefined();
  await softDeleteLifeNote(id); await purgeLifeNote(id);
  expect(await db.attachments.get(ref)).toBeUndefined();
});
