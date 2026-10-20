import { expect, it } from 'vitest';
import { chatSearchSources } from '../src/features/life/chatSearchSources';
import { webSearchEndpoint } from '../src/core/chatWebSearch';

it('仅显示工具来源，标题和链接属性转义，不自动加载站点图标', () => {
  const html = chatSearchSources({ status: 'searched', sources: [{ title: '<img src=x onerror=alert(1)>', url: 'https://source.example.invalid/?a=1&b=2' }] });
  expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
  expect(html).toContain('referrerpolicy="no-referrer"');
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  expect(html).toContain('来源（1）');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'https://user:pass@example.invalid/']) {
    expect(chatSearchSources({ status: 'searched', sources: [{ title: '错误', url }] })).toBe('');
  }
  expect(chatSearchSources(undefined)).toBe('');
  expect(chatSearchSources({ status: 'searched', sources: [] })).toContain('未返回可用来源');
  expect(chatSearchSources({ status: 'not-used', sources: [] })).toContain('本次未使用联网搜索');
});

it('按官方地址边界与已确认模型选择协议，保留原业务空间和地域', () => {
  for (const host of ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'workspace.cn-beijing.maas.aliyuncs.com']) {
    expect(webSearchEndpoint(`https://${host}/compatible-mode/v1/chat/completions`, 'qwen3.8-max'))
      .toBe(`https://${host}/compatible-mode/v1/responses`);
  }
  for (const url of ['https://dashscope.aliyuncs.com.evil.invalid/compatible-mode/v1', 'https://evil.invalid/compatible-mode/v1',
    'http://dashscope.aliyuncs.com/compatible-mode/v1', 'https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1?override=1']) {
    expect(webSearchEndpoint(url, 'qwen3.8-max')).toBeUndefined();
  }
  expect(webSearchEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1', 'unknown-model')).toBeUndefined();
});
