/**
 * 拾光 · AI 记账收件箱 · 系统分享接收（features/ai-inbox）
 * Capacitor 原生平台下注册 @capgo/capacitor-share-target 的 shareReceived 监听：
 * texts → rawText 素材项；files → 读 uri 为 Blob → 写 attachments → 素材项。
 * 入队后打开收件箱子页并触发识别（经 aiInbox.notifyShareReceived，shell 未就绪时缓冲）。
 *
 * 注册时机：main.ts 解锁及外壳初始化后调用；插件缓冲启动 intent 并补发。
 * Web 端静默跳过。
 */
import { Capacitor } from '@capacitor/core';
import { CapacitorShareTarget, type ShareReceivedEvent, type SharedFile } from '@capgo/capacitor-share-target';
import type { AiPendingItem } from '../../core/types';
import { addAiPendingItems, saveAiAttachment } from '../../core/repo/aiRepo';
import { notifyShareReceived } from './aiInbox';
import { showToast } from '../shell/toast';

/** 生成待识别素材项骨架 */
function rawItem(partial: Partial<AiPendingItem>): AiPendingItem {
  return {
    tempId: crypto.randomUUID(),
    status: 'pending',
    source: 'share',
    createdAt: Date.now(),
    ...partial,
  };
}

/** 读取分享文件 uri 为 Blob（file:// 路径经 convertFileSrc 转为 WebView 可 fetch 的地址） */
async function fetchSharedBlob(file: SharedFile): Promise<Blob> {
  const src = file.uri.startsWith('data:') ? file.uri : Capacitor.convertFileSrc(file.uri);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`读取分享文件失败：${res.status}`);
  return res.blob();
}

/** shareReceived 事件处理：全部素材入队后打开收件箱并触发识别 */
export async function handleShare(event: ShareReceivedEvent): Promise<void> {
  const items: AiPendingItem[] = [];
  for (const text of event.texts ?? []) {
    if (text.trim()) items.push(rawItem({ rawText: text.trim() }));
  }
  for (const file of event.files ?? []) {
    if (!file.mimeType.startsWith('image/')) continue;
    try {
      const blob = await fetchSharedBlob(file);
      const attachmentId = await saveAiAttachment(blob, file.name);
      items.push(rawItem({ attachmentId }));
    } catch (err) {
      console.warn('[ai-inbox] 分享图片读取失败', err);
    }
  }
  if (!items.length) return;
  await addAiPendingItems(items);
  notifyShareReceived();
}

/**
 * 注册系统分享监听（main.ts 在解锁及界面初始化后调用一次）。
 * 非原生平台（Web/PWA）无系统分享入口，静默跳过。
 */
export function initShareListener(): void {
  if (!Capacitor.isNativePlatform()) return;
  let queue = Promise.resolve();
  void CapacitorShareTarget.addListener('shareReceived', (event) => {
    queue = queue.then(() => handleShare(event)).catch(err => {
      console.error('[ai-inbox] 处理分享失败:', err);
      showToast(err instanceof Error ? err.message : '分享处理失败，请重试');
    });
  }).catch((err) => console.warn('[ai-inbox] 分享监听注册失败', err));
}
