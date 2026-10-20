import { expect, it } from 'vitest';
import { liveVoiceSearch, sanitizeVoiceSearch, supportsVoiceSearch } from '../src/core/liveVoiceSearch';

const usage = (count: unknown) => ({ plugins: { search: { count } } });
const source = { title: '天气预报', url: 'https://weather.invalid/beijing' };
it('只根据本轮实际搜索计量确认使用，过滤并去重结构化来源', () => {
  const result = liveVoiceSearch({ status: 'completed', usage: usage(1), search_info: { search_results: [source, source, { url: 'javascript:alert(1)' }, { url: 'https://user:secret@unsafe.invalid/' }] } });
  expect(result).toEqual({ status: 'searched', sources: [source] });
  expect(liveVoiceSearch({ status: 'completed', usage: usage(2), output: [{ content: [{ transcript: '模型说已经搜索 https://guessed.invalid/' }] }] })).toEqual({ status: 'searched', sources: [] });
  expect(liveVoiceSearch({ status: 'completed', usage: usage(0), search_results: [source] })).toEqual({ status: 'not-used', sources: [] });
});
it('缺少或非法计量不猜测，失败不把来源当作搜索成功', () => {
  for (const count of [undefined, '1', -1, 1.5, Infinity]) expect(liveVoiceSearch({ status: 'completed', usage: usage(count), search_results: [source] })).toEqual({ status: 'unknown', sources: [] });
  expect(liveVoiceSearch({ status: 'failed', usage: usage(1), search_results: [source] })).toEqual({ status: 'failed', sources: [] });
});
it('原生桥搜索状态复用来源边界，最多保留12条，其他状态不携带链接', () => {
  expect(sanitizeVoiceSearch({ status: 'searched', sources: [source, { url: 'data:text/html,unsafe' }] })).toEqual({ status: 'searched', sources: [source] });
  expect(sanitizeVoiceSearch({ status: 'not-used', sources: [source] })).toEqual({ status: 'not-used', sources: [] });
  expect(sanitizeVoiceSearch({ status: 'made-up', sources: [] })).toBeUndefined();
  expect(sanitizeVoiceSearch({ status: 'searched', sources: Array.from({ length: 30 }, (_, i) => ({ url: `https://source.invalid/${i}` })) })?.sources).toHaveLength(12);
});
it('只为明确支持的实时模型启用搜索，不挂到旧Qwen-Audio上', () => {
  expect(supportsVoiceSearch('qwen3.8-omni-flash-realtime')).toBe(true);
  expect(supportsVoiceSearch('qwen3.5-omni-plus-realtime')).toBe(true);
  expect(supportsVoiceSearch('qwen-audio-3.1-realtime-plus')).toBe(false);
});
