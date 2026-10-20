import { esc } from '../../core/esc';
import { safeSearchSource, validChatWebSearch } from '../../core/chatWebSearch';

/** 不解析正文中的链接；仅为通过校验的工具来源提供显式打开入口，不预取网页/图标。 */
export function chatSearchSources(value: unknown): string {
  if (!validChatWebSearch(value)) return '';
  const labels = {
    enabled: '可联网搜索', searching: '正在联网搜索…', searched: '已联网搜索',
    'not-used': '本次未使用联网搜索', unsupported: '当前配置未接入联网搜索', failed: '联网搜索未完成',
  };
  const sources = value.sources.map(safeSearchSource).filter(source => source != null);
  const status = value.status === 'searched' && !sources.length ? '已联网搜索，未返回可用来源' : labels[value.status];
  return `<section class="chat-web-search" data-chat-search="${value.status}" aria-label="本次联网搜索"><p class="chat-search-status">${status}</p>${sources.length
    ? `<details class="chat-search-sources"><summary>来源（${sources.length}）</summary><ol>${sources.map(source => `<li><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"><span>${esc(source.title)}</span><small>${esc(new URL(source.url).hostname)}</small></a></li>`).join('')}</ol></details>` : ''}</section>`;
}
