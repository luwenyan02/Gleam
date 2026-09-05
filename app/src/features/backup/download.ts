/**
 * 拾光 · 导出文件落地工具（features/backup/download）
 * Web：<a download> + blob URL 触发浏览器下载（原有行为不变）；
 * Android 原生壳（Capacitor WebView 不支持 <a download>）：
 *   @capacitor/filesystem 写入公共 Documents/拾光/ 后，
 *   用 @capacitor/share 弹出系统分享面板（可存文件、发网盘）。
 * 插件按需动态 import，Web 构建仅多出惰性 chunk，不影响首屏。
 */
import { Capacitor } from '@capacitor/core';

/** Blob → base64（不含 data: 前缀），供 Filesystem.writeFile 使用 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 把 Blob 存为用户可取回的文件。
 * @returns 提示语（原生端含落盘位置；Web 端为空，沿用调用方文案）
 */
export async function saveBlobFile(blob: Blob, name: string): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    return '';
  }

  const [{ Filesystem, Directory }, { Share }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor/share'),
  ]);
  const { uri } = await Filesystem.writeFile({
    path: `拾光/${name}`,
    data: await blobToBase64(blob),
    directory: Directory.Documents,
    recursive: true,
  });
  try {
    await Share.share({ title: name, files: [uri] });
  } catch {
    // 用户取消分享或设备无可用目标：文件已写入 Documents/拾光/，不视为失败
  }
  return `已保存到 文档/拾光/${name}`;
}
