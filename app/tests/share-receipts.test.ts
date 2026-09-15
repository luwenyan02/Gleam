import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleShare } from '../src/features/ai-inbox/shareListener';

const mocks = vi.hoisted(() => ({
  action: 'receipt' as string | undefined,
  attach: vi.fn(), prepare: vi.fn(), enqueue: vi.fn(), save: vi.fn(), notify: vi.fn(),
}));
vi.mock('../src/features/entry/entrySheet', () => ({ attachSharedReceipts: mocks.attach }));
vi.mock('../src/features/entry/receiptEditor', () => ({ prepareReceipt: mocks.prepare }));
vi.mock('../src/core/repo/aiRepo', () => ({ addAiPendingItems: mocks.enqueue, saveAiAttachment: mocks.save }));
vi.mock('../src/features/ai-inbox/aiInbox', () => ({ notifyShareReceived: mocks.notify }));
vi.mock('../src/features/shell/toast', () => ({ showToast: vi.fn() }));
vi.mock('../src/shared/pickList', () => ({ openPickList: (options: {onPick: (value: string) => void; onCancel: () => void}) => {
  if (mocks.action) options.onPick(mocks.action); else options.onCancel();
} }));

const shared = { title: '', texts: [], files: [{ name: '虚构.png', mimeType: 'image/png', uri: 'data:image/png;base64,AA==' }] };
beforeEach(() => {
  vi.clearAllMocks(); mocks.action = 'receipt';
  vi.stubGlobal('document', { querySelector: () => null, body: {} });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['fixture'], { type: 'image/png' })) }));
  mocks.prepare.mockImplementation(async (file: File) => ({ blob: file, name: file.name }));
  mocks.save.mockResolvedValue(7);
});
afterEach(() => vi.unstubAllGlobals());

it('选择凭证仅加入本地草稿，不入 AI 队列或调用识别', async () => {
  await handleShare(shared);
  expect(mocks.attach).toHaveBeenCalledOnce();
  expect(mocks.attach.mock.calls[0]?.[0][0].name).toBe('虚构.png');
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});
it('取消分享用途选择不读取图片也不写入', async () => {
  mocks.action = undefined;
  await handleShare(shared);
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.attach).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it('明确选择识别才入队并通知 AI', async () => {
  mocks.action = 'recognize';
  await handleShare(shared);
  expect(mocks.attach).not.toHaveBeenCalled();
  expect(mocks.enqueue).toHaveBeenCalledWith([expect.objectContaining({ attachmentId: 7, source: 'share' })]);
  expect(mocks.notify).toHaveBeenCalledOnce();
});
it('图片验证失败不会向草稿追加部分成功的素材', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('图片损坏'));
  await expect(handleShare(shared)).rejects.toThrow('图片损坏');
  expect(mocks.attach).not.toHaveBeenCalled();
});
