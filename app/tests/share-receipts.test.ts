import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleShare } from '../src/features/ai-inbox/shareListener';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(), save: vi.fn(), notify: vi.fn(),
  pick: vi.fn((options: { onCancel: () => void }) => options.onCancel()),
}));
vi.mock('../src/core/repo/aiRepo', () => ({ addAiPendingItems: mocks.enqueue, saveAiAttachment: mocks.save }));
vi.mock('../src/features/ai-inbox/aiInbox', () => ({ notifyShareReceived: mocks.notify }));
vi.mock('../src/shared/pickList', () => ({ openPickList: mocks.pick }));

const image = { name: '虚构.png', mimeType: 'image/png', uri: 'data:image/png;base64,AA==' };
const shared = { title: '', texts: [], files: [image] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', { querySelector: () => null, body: {} });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['fixture'], { type: 'image/png' })) }));
  mocks.save.mockResolvedValue(7);
  mocks.enqueue.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('分享图片直接保存素材并进入 AI 识别，不再选择用途', async () => {
  await handleShare(shared);
  expect(mocks.pick).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledWith(expect.any(Blob), '虚构.png');
  expect(mocks.enqueue).toHaveBeenCalledWith([expect.objectContaining({ attachmentId: 7, source: 'share', status: 'pending' })]);
  expect(mocks.notify).toHaveBeenCalledOnce();
  expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(mocks.notify.mock.invocationCallOrder[0]);
});

it('多张图片与文字全部保存后只打开一次收件箱，忽略空白文字和非图片文件', async () => {
  mocks.save.mockResolvedValueOnce(7).mockResolvedValueOnce(8);
  await handleShare({ ...shared, texts: ['  午餐 23 元  ', ' '], files: [image, { ...image, name: '虚构2.png' }, { ...image, mimeType: 'application/pdf' }] });
  expect(mocks.enqueue).toHaveBeenCalledOnce();
  const items = mocks.enqueue.mock.calls[0][0];
  expect(items).toEqual([
    expect.objectContaining({ rawText: '午餐 23 元', source: 'share' }),
    expect.objectContaining({ attachmentId: 7, source: 'share' }),
    expect.objectContaining({ attachmentId: 8, source: 'share' }),
  ]);
  expect(new Set(items.map((item: { tempId: string }) => item.tempId)).size).toBe(3);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(mocks.notify).toHaveBeenCalledOnce();
});

it('没有可识别素材时不写入、不打开收件箱', async () => {
  await handleShare({ ...shared, texts: [' '], files: [{ ...image, mimeType: 'application/pdf' }] });
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});

it('一张图片读取失败不影响同批其余图片识别', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 404 } as Response);
  await handleShare({ ...shared, files: [image, { ...image, name: '有效.png' }] });
  expect(mocks.save).toHaveBeenCalledOnce();
  expect(mocks.save).toHaveBeenCalledWith(expect.any(Blob), '有效.png');
  expect(mocks.enqueue).toHaveBeenCalledWith([expect.objectContaining({ attachmentId: 7 })]);
  expect(mocks.notify).toHaveBeenCalledOnce();
});

it('全部图片读取失败时不创建空识别任务', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(fetch).mockRejectedValueOnce(new Error('无法读取图片'));
  await handleShare(shared);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.notify).not.toHaveBeenCalled();
});

it('素材入队失败不触发识别，错误交给分享监听处理', async () => {
  mocks.enqueue.mockRejectedValueOnce(new Error('存储失败'));
  await expect(handleShare({ ...shared, files: [], texts: ['午餐 23 元'] })).rejects.toThrow('存储失败');
  expect(mocks.notify).not.toHaveBeenCalled();
});
