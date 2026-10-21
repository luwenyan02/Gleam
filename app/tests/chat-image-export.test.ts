import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: false,
  save: vi.fn(),
  write: vi.fn(),
  remove: vi.fn(),
  share: vi.fn(),
  canShare: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => mocks.native } }));
vi.mock('../src/features/backup/download', () => ({ saveBlobFile: mocks.save }));
vi.mock('@capacitor/filesystem', () => ({ Filesystem: { writeFile: mocks.write, deleteFile: mocks.remove }, Directory: { Cache: 'CACHE', Documents: 'DOCUMENTS' } }));
vi.mock('@capacitor/share', () => ({ Share: { share: mocks.share, canShare: mocks.canShare } }));

import { imageFileName, validateImageBlob, saveImageFile, shareImageFile } from '../src/shared/imageExport';

const png = () => new Blob(['fictional image bytes'], { type: 'image/png' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native = false;
  mocks.save.mockResolvedValue('');
  mocks.write.mockResolvedValue({ uri: 'file:///cache/chat-images/image.png' });
  mocks.remove.mockResolvedValue(undefined);
  mocks.share.mockResolvedValue({});
  mocks.canShare.mockResolvedValue({ value: true });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,ZmljdGlvbmFs';
    onload?: () => void;
    readAsDataURL() { this.onload?.(); }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('图片边界与文件名', () => {
  it('只接受非空JPEG/PNG/WebP，大小上限为10MiB', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) expect(() => validateImageBlob(new Blob(['x'], { type }))).not.toThrow();
    for (const type of ['image/svg+xml', 'text/html', 'image/gif', '']) expect(() => validateImageBlob(new Blob(['x'], { type }))).toThrow('JPEG、PNG 或 WebP');
    expect(() => validateImageBlob(new Blob([], { type: 'image/png' }))).toThrow('为空');
    expect(() => validateImageBlob(new Blob([new Uint8Array(10 * 1024 * 1024)], { type: 'image/png' }))).not.toThrow();
    expect(() => validateImageBlob(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' }))).toThrow('10 MiB');
  });

  it('去掉路径、控制字符与错误后缀，强制匹配MIME并限制UTF8文件名长度', () => {
    expect(imageFileName('../../账单.svg', 'image/png')).toBe('账单.png');
    expect(imageFileName('C:\\secret\\照片.exe', 'image/jpeg')).toBe('照片.jpg');
    expect(imageFileName('../..', 'image/webp')).toBe('拾光图片.webp');
    const name = imageFileName(`../${'长'.repeat(500)}\u202e\u0000.svg`, 'image/png');
    expect(name).not.toMatch(/[\\/\u0000\u202e]/);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(120);
    expect(name).toMatch(/\.png$/);
    for (const mime of ['image/svg+xml', '__proto__', 'toString']) expect(() => imageFileName('图', mime)).toThrow('JPEG、PNG 或 WebP');
  });

  it('保存前校验；保存反馈只报告实际下载或落盘状态', async () => {
    expect(await saveImageFile(png(), '../图.exe')).toBe('已发起图片下载');
    expect(mocks.save).toHaveBeenCalledWith(expect.any(Blob), '图.png');
    mocks.save.mockResolvedValue('已保存到 文档/拾光/图.png');
    expect(await saveImageFile(png(), '图')).toBe('已保存到 文档/拾光/图.png');
    await expect(saveImageFile(new Blob(['x'], { type: 'image/svg+xml' }), '图')).rejects.toThrow();
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
});

describe('Web文件分享', () => {
  it('用canShare检查实际File并将本机Blob交给系统', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { share, canShare });
    expect(await shareImageFile(png(), '../../图.svg')).toBe('已交给系统分享');
    const payload = share.mock.calls[0][0];
    expect(payload.files[0]).toBeInstanceOf(File);
    expect(payload.files[0].name).toBe('图.png');
    expect(payload.files[0].type).toBe('image/png');
    expect(canShare).toHaveBeenCalledWith({ files: payload.files });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('取消与真实失败区分；失败不悄悄改成保存成功', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    vi.stubGlobal('navigator', { share, canShare: () => true });
    expect(await shareImageFile(png(), '图')).toBe('已取消分享');
    share.mockRejectedValue(new Error('permission denied'));
    await expect(shareImageFile(png(), '图')).rejects.toThrow('permission denied');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unsupported', 'throws'])('文件分享不可用(%s)时明确告知下载兜底', async mode => {
    vi.stubGlobal('navigator', mode === 'missing' ? {} : { share: vi.fn(), canShare: () => { if (mode === 'throws') throw new TypeError('unsupported'); return false; } });
    expect(await shareImageFile(png(), '图')).toBe('此设备不支持图片分享，已发起图片下载');
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('旧浏览器没有File构造器时仍可下载兜底', async () => {
    vi.stubGlobal('File', undefined);
    expect(await shareImageFile(png(), '图')).toBe('此设备不支持图片分享，已发起图片下载');
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});

describe('Android保存图片', () => {
  beforeEach(() => { mocks.native = true; });

  it('仅写Documents并返回实际目录，不唤起分享、不写Cache', async () => {
    const result = await saveImageFile(png(), '../../图.exe');
    const path = mocks.write.mock.calls[0][0].path;
    expect(path).toMatch(/^拾光\/图-[0-9a-f]{16}\.png$/);
    expect(result).toBe(`已保存到 文档/${path}`);
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith({ path, data: 'ZmljdGlvbmFs', directory: 'DOCUMENTS', recursive: true });
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.canShare).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('连续保存同名图片使用不同路径，长中文名仍在255字节以内', async () => {
    const name = `${'长'.repeat(500)}.png`;
    const first = await saveImageFile(png(), name);
    const second = await saveImageFile(png(), name);
    const paths = mocks.write.mock.calls.map(([options]) => options.path);
    expect(paths[0]).not.toBe(paths[1]);
    expect(first).toBe(`已保存到 文档/${paths[0]}`);
    expect(second).toBe(`已保存到 文档/${paths[1]}`);
    for (const path of paths) {
      expect(path).toMatch(/^拾光\/长+-[0-9a-f]{16}\.png$/);
      expect(new TextEncoder().encode(path.split('/').pop()).length).toBeLessThan(255);
    }
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.canShare).not.toHaveBeenCalled();
  });

  it('Documents落盘失败保留原始异常，不误报保存成功', async () => {
    const failure = new Error('Documents permission denied');
    mocks.write.mockRejectedValue(failure);
    await expect(saveImageFile(png(), '图')).rejects.toBe(failure);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe('Android Cache分享', () => {
  beforeEach(() => { mocks.native = true; });

  it('只写Cache临时路径，经系统分享且不生成Documents副本', async () => {
    expect(await shareImageFile(png(), '../../图.exe')).toBe('已交给系统分享');
    const write = mocks.write.mock.calls[0][0];
    expect(write.directory).toBe('CACHE');
    expect(write.path).toMatch(/^chat-images\/[a-zA-Z0-9-]+-图\.png$/);
    expect(write.path).not.toContain('..');
    expect(write.data).toBe('ZmljdGlvbmFs');
    expect(mocks.share).toHaveBeenCalledWith({ title: '图.png', files: ['file:///cache/chat-images/image.png'] });
    expect(mocks.save).not.toHaveBeenCalled();
    // 接收方可能仍异步读取，成功后保留系统管理的Cache文件。
    expect(mocks.remove).not.toHaveBeenCalled();
    await shareImageFile(png(), '../../图.exe');
    expect(mocks.write.mock.calls[1][0].path).not.toBe(write.path);
  });

  it('设备无分享能力时不写文件、不报告成功', async () => {
    mocks.canShare.mockResolvedValue({ value: false });
    await expect(shareImageFile(png(), '图')).rejects.toThrow('不支持图片分享');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('精确识别插件取消并清理；真实失败保持原异常，清理失败不覆盖原异常', async () => {
    mocks.share.mockRejectedValue(new Error('Share canceled'));
    expect(await shareImageFile(png(), '图')).toBe('已取消分享');
    expect(mocks.remove).toHaveBeenCalledWith({ path: mocks.write.mock.calls[0][0].path, directory: 'CACHE' });
    const failure = new Error('FileProvider unavailable');
    mocks.share.mockRejectedValue(failure);
    mocks.remove.mockRejectedValue(new Error('cleanup failed'));
    await expect(shareImageFile(png(), '图')).rejects.toBe(failure);
  });

  it('读图和落盘失败不会进入分享或误报成功', async () => {
    vi.stubGlobal('FileReader', class { error = new Error('read failed'); onerror?: () => void; readAsDataURL() { this.onerror?.(); } });
    await expect(shareImageFile(png(), '图')).rejects.toThrow('read failed');
    expect(mocks.share).not.toHaveBeenCalled();
    vi.stubGlobal('FileReader', class { result = 'data:image/png;base64,eA=='; onload?: () => void; readAsDataURL() { this.onload?.(); } });
    mocks.write.mockRejectedValue(new Error('disk full'));
    await expect(shareImageFile(png(), '图')).rejects.toThrow('disk full');
    expect(mocks.share).not.toHaveBeenCalled();
  });
});
