import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/core/db';
import type { Entry, LifeChatMessage } from '../../src/core/types';
import { secretStore } from '../../src/core/secretStore';
import { getSetting, setSetting } from '../../src/core/repo/settingsRepo';
import { continueLifeChat, getLifeAiDestination, type LifeAiInput } from '../../src/core/repo/lifeAiRepo';
import {
  approveLifeLedgerReview, getLifeLedgerReview, lifeLedgerReviewText, revokeLifeLedgerGrant,
  type LifeLedgerGrant, type LifeLedgerReview, type LifeLedgerScope,
} from '../../src/core/repo/lifeLedgerContextRepo';
import { installOfflineOutbound } from './outbound';

// Every value is fictional. No endpoint, credential, record, or answer comes from a user.
const outbound = installOfflineOutbound(import.meta.url);
const destination = { baseUrl: 'https://fictional-ledger.invalid/v1', model: 'fictional-eval-model' };
const endpoint = `${destination.baseUrl}/chat/completions`;
const question = '分析我 2026 年 9 月的支出。';
const scope: LifeLedgerScope = { month: '2026-09', period: 'calendar', includeIncome: false };
const at = (month: number, day = 10) => new Date(2026, month - 1, day, 12).getTime();
const sentinel = {
  account: 'FICTIONAL_PRIVATE_ACCOUNT_Q7', balance: 654321987,
  merchant: 'FICTIONAL_PRIVATE_MERCHANT_R8', tag: 'FICTIONAL_PRIVATE_TAG_S9',
  note: 'FICTIONAL_PRIVATE_ENTRY_NOTE_T2', lifeNote: 'FICTIONAL_PRIVATE_DIARY_U3',
  photoName: 'FICTIONAL_PRIVATE_PHOTO_V4.png', photoBytes: 'FICTIONAL_PRIVATE_PHOTO_BYTES_W5',
  photoUrl: 'data:image/png;base64,RklDVElPTkFMX1BSSVZBVEVfUEhPVE8=',
  userChat: 'FICTIONAL_PRIVATE_USER_CHAT_X6', assistantChat: 'FICTIONAL_PRIVATE_ASSISTANT_CHAT_Y7',
  income: 7654321, otherMonth: 8765432, deleted: 3210987, transfer: 4321098, loan: 5432109,
};
const rawMockReply = 'FICTIONAL MOCK OUTPUT: 2 + 2 = 5; this is transport evidence, not a model-quality assertion.';
const row = (id: number, patch: Partial<Entry>): Entry => ({
  id, type: 'expense', amount: 24681, occurredAt: at(9), categoryId: 2, accountId: 1,
  reimburseStatus: 'none', deletedAt: 0, createdAt: 1, updatedAt: 1, ...patch,
});

function response(content = rawMockReply): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function allowResponse(): void { outbound.respondWith(endpoint, () => response()); }

function input(grant: LifeLedgerGrant, patch: Partial<LifeAiInput> = {}): LifeAiInput {
  return { body: '', messages: [{ role: 'user', content: question }], ledgerGrant: grant, expectedDestination: destination, ...patch };
}

async function approve(selectedScope = scope): Promise<LifeLedgerGrant> {
  return approveLifeLedgerReview(await getLifeLedgerReview(question, selectedScope), destination);
}

/** Check both persistence equality and attempted writes, including create-then-delete. */
async function readOnly<T>(operation: () => Promise<T>): Promise<T> {
  const tables = db.tables.filter(table => table.name !== 'settings');
  const before = await Promise.all(tables.map(table => table.toArray()));
  const writes: string[] = [];
  const listeners = tables.map(table => {
    const creating = () => { writes.push(`${table.name}:creating`); };
    const updating = () => { writes.push(`${table.name}:updating`); };
    const deleting = () => { writes.push(`${table.name}:deleting`); };
    table.hook('creating', creating);
    table.hook('updating', updating);
    table.hook('deleting', deleting);
    return { table, creating, updating, deleting };
  });
  try { return await operation(); }
  finally {
    for (const { table, creating, updating, deleting } of listeners) {
      table.hook('creating').unsubscribe(creating);
      table.hook('updating').unsubscribe(updating);
      table.hook('deleting').unsubscribe(deleting);
    }
    expect(writes, 'Review and AI transport must never write ledger/life tables').toEqual([]);
    expect(await Promise.all(tables.map(table => table.toArray()))).toEqual(before);
  }
}

function sent() {
  expect(outbound.requests).toHaveLength(1);
  const request = outbound.requests[0];
  const payload = JSON.parse(String(request.init.body)) as { model: string; messages: { role: string; content: string }[] };
  expect(request.url).toBe(endpoint);
  expect(request.init.method).toBe('POST');
  expect(payload.model).toBe(destination.model);
  expect(payload.messages.map(message => message.role)).toEqual(['system', 'user']);
  return { request, payload, review: JSON.parse(payload.messages[1].content) as LifeLedgerReview };
}

function expectPrivateValuesAbsent(value: unknown, includeIncome = false): void {
  const serialized = JSON.stringify(value);
  for (const [name, token] of Object.entries(sentinel)) {
    if (includeIncome && name === 'income') continue;
    expect(serialized, `Private sentinel leaked: ${name}`).not.toContain(String(token));
  }
  for (const key of ['accountId', 'merchantId', 'balance', 'photoRefs', 'image_url', 'ledgerGrant', 'reconcileBeforeBalance']) {
    expect(serialized).not.toContain(`"${key}"`);
  }
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await setSetting('ai.baseUrl', destination.baseUrl);
  await setSetting('ai.model', destination.model);
  await setSetting('life.aiEnabled', true);
  await setSetting('reimburse.countAsIncome', false);
  await setSetting('accounting.monthStartDay', 1);
  await secretStore.set('ai.apiKey', 'fictional-offline-placeholder');
  await db.accounts.put({ id: 1, name: sentinel.account, group: 'cash', balance: sentinel.balance,
    hidden: false, countInNetWorth: true, sortOrder: 0, createdAt: 1, updatedAt: 1 });
  await db.categories.bulkPut([
    { id: 1, kind: 'expense', name: '虚构餐饮', icon: '', sortOrder: 0, createdAt: 1, updatedAt: 1 },
    { id: 2, kind: 'expense', name: '虚构午餐', parentId: 1, icon: '', sortOrder: 1, createdAt: 1, updatedAt: 1 },
  ]);
  await db.merchants.put({ id: 1, name: sentinel.merchant, useCount: 1, createdAt: 1, updatedAt: 1 });
  await db.tags.put({ id: 1, name: sentinel.tag, createdAt: 1, updatedAt: 1 });
  await db.entryTags.put({ id: 1, entryId: 1, tagId: 1 });
  await db.attachments.put({ id: 1, mime: 'image/png', name: sentinel.photoName,
    size: sentinel.photoBytes.length, blob: new Blob([sentinel.photoBytes]), thumbnail: sentinel.photoUrl, createdAt: 1, updatedAt: 1 });
  await db.entryAttachments.put({ id: 1, entryId: 1, attachmentId: 1, sortOrder: 0 });
  await db.lifeNotes.put({ id: 1, kind: 'diary', body: sentinel.lifeNote, photoRefs: [1],
    conversation: [{ role: 'user', content: sentinel.userChat }], occurredAt: at(9), deletedAt: 0, createdAt: 1, updatedAt: 1 });
  await db.entries.bulkPut([
    row(1, { merchantId: 1, note: sentinel.note, lifeNoteId: 1, reconcileBeforeBalance: sentinel.balance }),
    row(2, { amount: 1357, refundFlag: true }),
    row(3, { amount: 9021, reimburseStatus: 'done', reimbursedAmount: 3210, reimbursedAt: at(9, 15), reimburseAccountId: 1 }),
    row(4, { type: 'income', amount: sentinel.income }),
    row(5, { amount: sentinel.otherMonth, occurredAt: at(8) }),
    row(6, { amount: sentinel.deleted, deletedAt: 1 }),
    row(7, { type: 'transfer', amount: sentinel.transfer, fromAccountId: 1, toAccountId: 2 }),
    row(8, { type: 'loan', amount: sentinel.loan, loanKind: 'borrow', fromAccountId: 2, toAccountId: 1 }),
  ]);
});

afterEach(async () => {
  await secretStore.remove('ai.apiKey');
  vi.restoreAllMocks();
});

describe('offline consent: local review and exact outbound boundary', () => {
  it('default review is local, does not enable AI, writes nothing, and makes zero requests', async () => {
    await setSetting('life.aiEnabled', false);
    const settingsBefore = await db.settings.toArray();
    await readOnly(async () => {
      const review = await getLifeLedgerReview(question, scope);
      expect(review.summary.totals.expenseFen).toBe(29135);
      expectPrivateValuesAbsent(review);
      expect(lifeLedgerReviewText(review)).toContain('净支出 ¥291.35');
    });
    expect(await getSetting('life.aiEnabled')).toBe(false);
    expect(await db.settings.toArray()).toEqual(settingsBefore);
    expect(outbound.requests).toHaveLength(0);
  });

  it('creating explicit approval alone does not send or persist a reusable grant', async () => {
    const before = await db.settings.toArray();
    await readOnly(async () => {
      const grant = await approve();
      expect(Object.isFrozen(grant)).toBe(true);
      expect(JSON.stringify(grant)).toBe('{"kind":"life-ledger-once"}');
      revokeLifeLedgerGrant(grant);
    });
    expect(await db.settings.toArray()).toEqual(before);
    expect(outbound.requests).toHaveLength(0);
  });

  it('approved preview equals the actual transmitted summary; amounts, scope, currency and provider agree', async () => {
    const review = await getLifeLedgerReview(question, scope);
    expect(review.summary).toEqual({
      scope: { month: '2026-09', period: 'calendar', includeIncome: false },
      range: { from: new Date(2026, 8, 1).getTime(), to: new Date(2026, 9, 1).getTime(), label: '2026/9/1 – 2026/9/30' },
      currency: 'CNY', unit: 'fen', reimbursementMode: 'offset',
      totals: { expenseFen: 29135, grossExpenseFen: 33702, refundFen: 1357, reimbursementOffsetFen: 3210, expenseCount: 2, refundCount: 1 },
      categories: [{ name: '虚构餐饮', expenseFen: 29135, count: 3 }],
    });
    const preview = lifeLedgerReviewText(review);
    for (const line of [
      `问题：${question}`, '范围：2026-09 自然月（2026/9/1 – 2026/9/30）',
      '支出 2 笔，原始支出 ¥337.02', '退款 1 笔，冲抵 ¥13.57',
      '到账报销按原支出周期冲抵 ¥32.10', '净支出 ¥291.35', '虚构餐饮：净支出 ¥291.35（含退款共 3 笔）',
    ]) expect(preview.split('\n')).toContain(line);
    expect(preview).not.toContain('收入 1 笔');
    expect(await getLifeAiDestination()).toEqual(destination);
    const grant = approveLifeLedgerReview(review, destination);
    const history: LifeChatMessage[] = [
      { role: 'user', content: sentinel.userChat, photos: [{ name: sentinel.photoName, dataUrl: sentinel.photoUrl }] },
      { role: 'assistant', content: sentinel.assistantChat, ledgerAnalysis: true, photoRefs: [1] },
      { role: 'user', content: question },
    ];
    allowResponse();
    const settingsBefore = await db.settings.toArray();
    await readOnly(async () => {
      // Deliberately nonsensical mock text proves forwarding, never model accuracy.
      expect(await continueLifeChat(input(grant, { messages: history }))).toEqual({ reply: rawMockReply, readyToSummarize: false });
      const actual = sent();
      expect(actual.review).toEqual(review);
      expect(actual.payload.messages[1].content).toBe(JSON.stringify(review));
      expectPrivateValuesAbsent(actual.request);
      expectPrivateValuesAbsent(review);
      expect(actual.review.summary).not.toHaveProperty('income');
      await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    });
    expect(await db.settings.toArray()).toEqual(settingsBefore);
    expect(outbound.requests).toHaveLength(1);
  });

  it('income is only transmitted after the include-income scope is explicitly approved', async () => {
    const review = await getLifeLedgerReview(question, { ...scope, includeIncome: true });
    expect(review.summary.income).toEqual({ incomeFen: 7654321, reimbursementIncomeFen: 0, count: 1 });
    expect(lifeLedgerReviewText(review)).toContain('收入 1 笔，合计 ¥76,543.21（其中报销到账 ¥0.00）');
    allowResponse();
    await readOnly(() => continueLifeChat(input(approveLifeLedgerReview(review, destination))));
    expect(sent().review).toEqual(review);
    expectPrivateValuesAbsent(sent().request, true);
  });

  it('mutating preview objects after approval cannot widen the cloned authorized scope', async () => {
    const review = await getLifeLedgerReview(question, scope);
    const approvedCopy = structuredClone(review);
    const destinationCopy = { ...destination };
    const grant = approveLifeLedgerReview(review, destinationCopy);
    review.summary.scope.includeIncome = true;
    review.summary.scope.month = '2026-08';
    review.summary.totals.expenseFen = 999999;
    destinationCopy.baseUrl = 'https://changed-preview.invalid/v1';
    allowResponse();
    await readOnly(() => continueLifeChat(input(grant)));
    expect(sent().review).toEqual(approvedCopy);
    expect(sent().review.summary).not.toHaveProperty('income');
  });

  it('concurrent attempts consume one approval at most once', async () => {
    const request = input(await approve());
    allowResponse();
    await readOnly(async () => {
      const results = await Promise.allSettled([continueLifeChat(request), continueLifeChat(request)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason.message).toContain('重新确认');
    });
    expect(outbound.requests).toHaveLength(1);
  });
});

describe('offline consent: stale, changed or forged authority', () => {
  it.each(['month', 'period', 'includeIncome'] as const)('a stale preview relabeled with changed %s scope is rejected', async field => {
    const review = await getLifeLedgerReview(question, scope);
    if (field === 'month') review.summary.scope.month = '2026-08';
    if (field === 'period') review.summary.scope.period = 'accounting';
    if (field === 'includeIncome') review.summary.scope.includeIncome = true;
    if (field === 'period') await setSetting('accounting.monthStartDay', 20);
    const request = input(approveLifeLedgerReview(review, destination));
    await readOnly(async () => {
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    });
    expect(outbound.requests).toHaveLength(0);
  });

  it('changing the current question invalidates approval even if the original question is restored', async () => {
    const request = input(await approve());
    await readOnly(async () => {
      await expect(continueLifeChat({ ...request, messages: [{ role: 'user', content: '分析我的收入。' }] })).rejects.toThrow('重新确认');
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    });
    expect(outbound.requests).toHaveLength(0);
  });

  it.each(['provider', 'model', 'missing destination'] as const)('changing the expected %s rejects before fetch and spends the grant', async change => {
    const request = input(await approve());
    const changed = change === 'provider' ? { ...destination, baseUrl: 'https://other-provider.invalid/v1' }
      : change === 'model' ? { ...destination, model: 'other-fictional-model' } : undefined;
    await readOnly(async () => {
      await expect(continueLifeChat({ ...request, expectedDestination: changed })).rejects.toThrow('重新确认');
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    });
    expect(outbound.requests).toHaveLength(0);
  });

  it.each(['provider', 'model'] as const)('actual configured %s changes require new approval even when the caller retains its old destination', async change => {
    const request = input(await approve());
    if (change === 'provider') await setSetting('ai.baseUrl', 'https://other-actual-provider.invalid/v1');
    else await setSetting('ai.model', 'other-actual-fictional-model');
    await readOnly(() => expect(continueLifeChat(request)).rejects.toThrow('配置已变化'));
    await setSetting('ai.baseUrl', destination.baseUrl);
    await setSetting('ai.model', destination.model);
    await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(0);
  });

  it.each(['amount', 'category', 'reimbursement setting', 'accounting start'] as const)('a changed %s invalidates the approved summary without a request', async change => {
    const selectedScope = change === 'accounting start' ? { ...scope, period: 'accounting' as const } : scope;
    const request = input(await approve(selectedScope));
    if (change === 'amount') await db.entries.update(1, { amount: 24682 });
    if (change === 'category') await db.categories.update(1, { name: '更改后的虚构分类' });
    if (change === 'reimbursement setting') await setSetting('reimburse.countAsIncome', true);
    if (change === 'accounting start') await setSetting('accounting.monthStartDay', 20);
    await readOnly(async () => {
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    });
    expect(outbound.requests).toHaveLength(0);
  });

  it.each(['forged', 'JSON restored', 'structured clone'] as const)('%s grant carries no authority and never falls back to ordinary chat', async kind => {
    const valid = await approve();
    const grant = kind === 'forged' ? { kind: 'life-ledger-once' } as LifeLedgerGrant
      : kind === 'JSON restored' ? JSON.parse(JSON.stringify(valid)) as LifeLedgerGrant : structuredClone(valid);
    await readOnly(() => expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认'));
    revokeLifeLedgerGrant(valid);
    expect(outbound.requests).toHaveLength(0);
  });

  it.each(['body', 'photo'] as const)('unapproved extra %s content is refused and the approval cannot be reused', async extra => {
    const request = input(await approve());
    const patch = extra === 'body' ? { body: sentinel.lifeNote } : { photos: [sentinel.photoUrl] };
    await readOnly(async () => {
      await expect(continueLifeChat({ ...request, ...patch })).rejects.toThrow('只发送');
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    });
    expect(outbound.requests).toHaveLength(0);
  });
});

describe('offline consent: cancellation, interruption and failures spend approval', () => {
  // These are grant lifecycle checks. They do not simulate GUI Cancel or Back buttons.
  it('a dismissed review produces no grant, no send, and no ledger write (cancel/back-equivalent boundary)', async () => {
    await readOnly(async () => {
      await getLifeLedgerReview(question, scope);
      // The caller discards the review without invoking approval or transport.
    });
    expect(outbound.requests).toHaveLength(0);
  });

  it('explicit revocation after cancellation or scope replacement prevents reusing the old grant', async () => {
    const grant = await approve();
    revokeLifeLedgerGrant(grant);
    const changedReview = await getLifeLedgerReview(question, { ...scope, month: '2026-08' });
    expect(changedReview.summary.scope.month).toBe('2026-08');
    await readOnly(async () => {
      await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
      await expect(continueLifeChat(input(grant))).rejects.toThrow('重新确认');
    });
    expect(outbound.requests).toHaveLength(0);
  });

  it('aborting before send makes zero requests and revokes the approval', async () => {
    const request = input(await approve());
    const controller = new AbortController();
    controller.abort();
    await readOnly(async () => {
      await expect(continueLifeChat({ ...request, signal: controller.signal })).rejects.toThrow('取消');
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    });
    expect(outbound.requests).toHaveLength(0);
  });

  it('aborting an in-flight request forwards abort to transport, rejects its late result, and forbids retry', async () => {
    const controller = new AbortController();
    const request = input(await approve());
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    let finish!: (value: Response) => void;
    outbound.respondWith(endpoint, () => { started(); return new Promise<Response>(resolve => { finish = resolve; }); });
    await readOnly(async () => {
      const pending = continueLifeChat({ ...request, signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow('取消');
      await didStart;
      controller.abort();
      expect(outbound.requests[0].init.signal?.aborted).toBe(true);
      finish(response());
      await rejected;
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    });
    expect(outbound.requests).toHaveLength(1);
  });

  it('disabling AI after approval but before send prevents outbound and revokes the grant', async () => {
    const request = input(await approve());
    await setSetting('life.aiEnabled', false);
    await readOnly(() => expect(continueLifeChat(request)).rejects.toThrow('开启生活 AI'));
    await setSetting('life.aiEnabled', true);
    await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(0);
  });

  it('late AI disable discards a returned response; re-enabling does not restore approval', async () => {
    const request = input(await approve());
    outbound.respondWith(endpoint, async () => { await setSetting('life.aiEnabled', false); return response(); });
    await readOnly(() => expect(continueLifeChat(request)).rejects.toThrow('结果未采用'));
    await setSetting('life.aiEnabled', true);
    await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    expect(outbound.requests).toHaveLength(1);
  });

  it.each([401, 403, 429, 503])('HTTP %s makes exactly one mock request, hides remote error content, and cannot reuse approval', async status => {
    const request = input(await approve());
    const remoteError = `FICTIONAL_REMOTE_ERROR_${sentinel.note}`;
    const failed = new Response(remoteError, { status });
    const readBody = vi.spyOn(failed, 'text');
    const readJson = vi.spyOn(failed, 'json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    outbound.respondWith(endpoint, () => failed);
    await readOnly(async () => {
      await expect(continueLifeChat(request)).rejects.toThrow('不可用');
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(readJson).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(outbound.requests).toHaveLength(1);
  });

  it('a network failure is sanitized, makes no automatic retry, and spends approval', async () => {
    const request = input(await approve());
    outbound.respondWith(endpoint, () => { throw new TypeError(`FICTIONAL_NETWORK_FAILURE_${sentinel.note}`); });
    await readOnly(async () => {
      await expect(continueLifeChat(request)).rejects.toThrow('生活 AI 暂时不可用，请稍后重试');
      await expect(continueLifeChat(request)).rejects.toThrow('重新确认');
    });
    expect(outbound.requests).toHaveLength(1);
  });
});
