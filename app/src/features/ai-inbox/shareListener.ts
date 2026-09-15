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
import { prepareReceipt } from '../entry/receiptEditor';
import { attachSharedReceipts } from '../entry/entrySheet';
import { openPickList } from '../../shared/pickList';
import { showToast } from '../shell/toast';

/** 先让用户决定用途，避免把只想留存的凭证发给 AI 服务。 */
function chooseImageAction(): Promise<'receipt' | 'recognize' | undefined> {
  return new Promise(resolve => openPickList({
    container: document.querySelector<HTMLElement>('.app') ?? document.body,
    title: '如何使用分享图片',
    items: [
      { value: 'receipt', label: '作为账单凭证', note: '保存在本机，不识别' },
      { value: 'recognize', label: 'AI 识别记账', note: '使用已配置的 AI 服务' },
    ],
    onPick: value => resolve(value as 'receipt' | 'recognize'),
    onCancel: () => resolve(undefined),
  }));
}

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
  const imageFiles = (event.files ?? []).filter(file => file.mimeType.startsWith('image/'));
  if (imageFiles.length) {
    const action = await chooseImageAction();
    if (!action) return;
    if (action === 'receipt') {
      if (imageFiles.length > 9) throw new Error('每笔最多 9 张凭证，请减少分享图片');
      const receipts = [];
      for (const file of imageFiles) {
        const blob = await fetchSharedBlob(file);
        receipts.push(await prepareReceipt(new File([blob], file.name ?? '分享凭证', { type: file.mimeType })));
      }
      await attachSharedReceipts(receipts);
      showToast('图片已加入账单草稿，保存后生效');
      return;
    }
  }
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
