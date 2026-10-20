import { getLifeAiDestination } from '../../core/repo/lifeAiRepo';
import { getSetting, setSetting } from '../../core/repo/settingsRepo';
import { confirmDialog } from '../shell/dialog';
import { webSearchEndpoint } from '../../core/chatWebSearch';

/** 每次调用先展示本次确切素材；设置开关不是全库读取授权。 */
export async function confirmLifeAi(preview: string, signal: AbortSignal): Promise<{ baseUrl: string; model: string } | false> {
  const [destination, enabled] = await Promise.all([getLifeAiDestination(), getSetting('life.aiEnabled')]);
  if (signal.aborted) return false;
  const accepted = await confirmDialog({
    title: enabled ? '本次发送给 AI 的内容' : '启用生活 AI 并发送？',
    message: `服务：${destination.baseUrl}\n模型：${destination.model}\n\n${preview}\n\n仅发送以上选中素材。内容将离开设备，服务方的数据处理规则适用。不会自动发送其他日记或账单。${webSearchEndpoint(destination.baseUrl, destination.model) ? '\n普通聊天可按问题调用服务商的联网搜索，查询由服务商处理，可能产生搜索费用；账本分析和整理记录不启用搜索。' : ''}`,
    okText: '同意并发送', cancelText: '先不发送',
  });
  if (!accepted || signal.aborted) return false;
  if (!enabled) await setSetting('life.aiEnabled', true);
  return signal.aborted ? false : destination;
}
