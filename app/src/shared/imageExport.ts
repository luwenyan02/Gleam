import { Capacitor } from '@capacitor/core';
import { saveBlobFile } from '../features/backup/download';

const EXTENSIONS: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 同一边界用于附件预览和图片导出；实际解码错误由预览的 img.onerror 处理。 */
export function validateImageBlob(blob: Blob): void {
  if (!Object.hasOwn(EXTENSIONS, blob.type)) throw new Error('仅支持 JPEG、PNG 或 WebP 图片');
  if (!blob.size) throw new Error('图片内容为空');
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 10 MiB');
}

/** 只保留文件名，后缀由MIME决定；限制UTF8字节数，避免Android文件系统越界。 */
export function imageFileName(name: string, mime: string): string {
  const extension = Object.hasOwn(EXTENSIONS, mime) ? EXTENSIONS[mime] : undefined;
  if (!extension) throw new Error('仅支持 JPEG、PNG 或 WebP 图片');
  const leaf = name.normalize('NFKC').split(/[\\/]/).pop() ?? '';
  const stem = leaf.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '')
    .replace(/\.[^.]*$/, '').replace(/^\.+|[.\s]+$/g, '').trim() || '拾光图片';
  let safe = '';
  const encoder = new TextEncoder();
  for (const character of stem) {
    if (encoder.encode(safe + character + extension).length > 120) break;
    safe += character;
  }
  return `${safe || '拾光图片'}${extension}`;
}

/** 返回下载已发起或实际落盘位置，不把浏览器下载当成已保存完成。 */
export async function saveImageFile(blob: Blob, name: string): Promise<string> {
  validateImageBlob(blob);
  const filename = imageFileName(name, blob.type);
  if (!Capacitor.isNativePlatform()) return (await saveBlobFile(blob, filename)) || '已发起图片下载';
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  // 原名至多120字节，附独立随机后缀后仍远小于255字节，重复保存不覆盖同名图片。
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const savedName = filename.replace(/(\.[^.]+)$/, `-${suffix}$1`);
  await Filesystem.writeFile({ path: `拾光/${savedName}`, data: await blobToBase64(blob), directory: Directory.Documents, recursive: true });
  return `已保存到 文档/拾光/${savedName}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(',', 2)[1];
      if (data) resolve(data);
      else reject(new Error('图片读取失败'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
    reader.onabort = () => reject(new Error('图片读取已取消'));
    reader.readAsDataURL(blob);
  });
}

/** 取消有单独反馈；真实分享异常保留给调用方，不伪装为成功或自动保存。 */
export async function shareImageFile(blob: Blob, name: string): Promise<string> {
  validateImageBlob(blob);
  const filename = imageFileName(name, blob.type);
  if (!Capacitor.isNativePlatform()) {
    const downloadFallback = async () => `此设备不支持图片分享，${await saveImageFile(blob, filename)}`;
    if (typeof File !== 'function') return downloadFallback();
    const file = new File([blob], filename, { type: blob.type });
    let canShare = false;
    try { canShare = typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] }) === true; }
    catch { /* 浏览器可能提供API但不支持文件类型。 */ }
    if (!canShare) return downloadFallback();
    try {
      await navigator.share({ title: filename, files: [file] });
      return '已交给系统分享';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return '已取消分享';
      throw error;
    }
  }

  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'), import('@capacitor/share'),
  ]);
  if (!(await Share.canShare()).value) throw new Error('此设备不支持图片分享，请使用保存图片');
  // Android file_paths.xml 已允许 cache-path；每次独立文件，避免覆盖仍在读取的附件。
  const path = `chat-images/${crypto.randomUUID()}-${filename}`;
  const { uri } = await Filesystem.writeFile({ path, data: await blobToBase64(blob), directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title: filename, files: [uri] });
    // 接收应用可能仍在异步读取；成功后保留系统管理的Cache，不生成Documents副本。
    return '已交给系统分享';
  } catch (error) {
    try { await Filesystem.deleteFile({ path, directory: Directory.Cache }); }
    catch { /* 清理错误不能覆盖真实分享错误。缓存仍由系统回收。 */ }
    if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Share canceled')) return '已取消分享';
    throw error;
  }
}
