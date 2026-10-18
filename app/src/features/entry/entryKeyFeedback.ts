import { Capacitor, registerPlugin } from '@capacitor/core';

const native = registerPlugin<{ keyFeedback(): Promise<void> }>('GleamEntry');

/** 反馈不阻塞输入；Android 跟随系统触感设置，网页按能力提供短振动。 */
export async function entryKeyFeedback(): Promise<void> {
  try {
    if (Capacitor.getPlatform() === 'android') await native.keyFeedback();
    else navigator.vibrate?.(12);
  } catch {
    // 旧包、无振动设备或浏览器拒绝时仍保留视觉反馈。
  }
}
