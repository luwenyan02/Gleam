import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { secretStore } from '../src/core/secretStore';
import { setSetting } from '../src/core/repo/settingsRepo';
import { approveLifeLedgerReview, getLifeLedgerReview } from '../src/core/repo/lifeLedgerContextRepo';
import { continueLifeChat } from '../src/core/repo/lifeAiRepo';

const destination = { baseUrl: 'https://freshness.invalid/v1', model: 'mock-only' };
const question = '分析我2026年9月的支出';
beforeEach(async () => {
  await db.delete(); await db.open();
  await setSetting('life.aiEnabled', true);
  await setSetting('ai.baseUrl', destination.baseUrl); await setSetting('ai.model', destination.model);
  await secretStore.set('ai.apiKey', 'fictional-test-placeholder');
  await db.entries.put({ id: 1, type: 'expense', amount: 12000, occurredAt: new Date(2026, 8, 10).getTime(),
    accountId: 1, reimburseStatus: 'none', deletedAt: 0, createdAt: 1, updatedAt: 1 });
});
afterEach(async () => { vi.unstubAllGlobals(); await secretStore.remove('ai.apiKey'); });

it.each(['provider', 'amount', 'same-total-source'] as const)('does not adopt an in-flight ledger answer after %s changes', async kind => {
  const review = await getLifeLedgerReview(question, { month: '2026-09', period: 'calendar', includeIncome: false });
  const grant = approveLifeLedgerReview(review, destination);
  const mock = vi.fn(async () => {
    if (kind === 'provider') await setSetting('ai.model', 'changed-provider-model');
    else if (kind === 'amount') await db.entries.update(1, { amount: 13000 });
    else await db.entries.update(1, { occurredAt: new Date(2026, 8, 11).getTime() });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Mock response only' } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', mock);
  await expect(continueLifeChat({ body: '', messages: [{ role: 'user', content: question }], ledgerGrant: grant, expectedDestination: destination })).rejects.toThrow(/变化|重新确认/);
  expect(mock).toHaveBeenCalledOnce();
  await expect(continueLifeChat({ body: '', messages: [{ role: 'user', content: question }], ledgerGrant: grant, expectedDestination: destination })).rejects.toThrow('重新确认');
  expect(mock).toHaveBeenCalledOnce();
});
