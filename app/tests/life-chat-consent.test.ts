import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { getSetting, setSetting } from '../src/core/repo/settingsRepo';

const mocks = vi.hoisted(() => ({ destination: vi.fn(), confirm: vi.fn() }));
vi.mock('../src/core/repo/lifeAiRepo', () => ({ getLifeAiDestination: mocks.destination }));
vi.mock('../src/features/shell/dialog', () => ({ confirmDialog: mocks.confirm }));
vi.mock('../src/core/chatWebSearch', () => ({ webSearchEndpoint: () => undefined }));
import * as consent from '../src/features/life/lifeAiConsent';

const destination = { baseUrl: 'https://synthetic-ai.invalid/v1', model: 'synthetic-chat' };
const signal = () => new AbortController().signal;

beforeEach(async () => {
  vi.resetAllMocks();
  await db.delete(); await db.open();
  mocks.destination.mockResolvedValue(destination);
});
afterEach(() => vi.restoreAllMocks());

it('已启用的聊天连续发送不再弹素材确认，每次仍使用当前目的地', async () => {
  await setSetting('life.aiEnabled', true);
  expect(await consent.getLifeChatDestination(signal())).toEqual(destination);
  const updated = { ...destination, model: 'synthetic-new-model' };
  mocks.destination.mockResolvedValue(updated);
  expect(await consent.getLifeChatDestination(signal())).toEqual(updated);
  expect(mocks.confirm).not.toHaveBeenCalled();
});

it('生活AI关闭时取消首次启用，不发送也不更改开关', async () => {
  mocks.confirm.mockResolvedValue(false);
  expect(await consent.getLifeChatDestination(signal())).toBe(false);
  expect(await getSetting('life.aiEnabled')).toBe(false);
  expect(mocks.confirm).toHaveBeenCalledOnce();
});

it('明确首次启用后后续消息直接发送', async () => {
  mocks.confirm.mockResolvedValue(true);
  expect(await consent.getLifeChatDestination(signal())).toEqual(destination);
  expect(await getSetting('life.aiEnabled')).toBe(true);
  expect(await consent.getLifeChatDestination(signal())).toEqual(destination);
  expect(mocks.confirm).toHaveBeenCalledOnce();
});

it('发送前取消不再读取配置或打开启用框', async () => {
  const controller = new AbortController(); controller.abort();
  expect(await consent.getLifeChatDestination(controller.signal)).toBe(false);
  expect(mocks.destination).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
});

it('启用确认等待中取消请求，即使后来点确认也不启用或发送', async () => {
  let accept!: (value: boolean) => void;
  mocks.confirm.mockImplementation(() => new Promise<boolean>(resolve => { accept = resolve; }));
  const controller = new AbortController();
  const pending = consent.getLifeChatDestination(controller.signal);
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
  controller.abort(); accept(true);
  expect(await pending).toBe(false);
  expect(await getSetting('life.aiEnabled')).toBe(false);
});

it('配置不可用时继续返回配置错误，不弹内容确认或启用AI', async () => {
  mocks.destination.mockRejectedValue(new Error('请先配置 AI'));
  await expect(consent.getLifeChatDestination(signal())).rejects.toThrow('请先配置 AI');
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(await getSetting('life.aiEnabled')).toBe(false);
});

it('独立素材整理保留原有确认，聊天免确认不扩展到其它记录', async () => {
  await setSetting('life.aiEnabled', true);
  mocks.confirm.mockResolvedValue(false);
  expect(await consent.confirmLifeAi('本次选中的虚构记录', signal())).toBe(false);
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('本次选中的虚构记录') }));
});
