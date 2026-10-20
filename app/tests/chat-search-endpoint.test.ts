import { expect, it } from 'vitest';
import { webSearchEndpoint } from '../src/core/chatWebSearch';

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
