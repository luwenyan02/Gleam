import { matchProviderId, modelPreset } from './aiModels';

/** 只修正已确认的参数不兼容，其余模型保留原先的低随机性。 */
export function chatOptions(baseUrl: string, model: string): Record<string, unknown> {
  const provider = matchProviderId(baseUrl);
  if (provider === 'openai' && /^gpt-(5\.6|6)/i.test(model)) return { reasoning_effort: 'low' };
  if ((provider === 'moonshot' || provider === 'dashscope') && model === 'kimi-k3') return { reasoning_effort: 'low' };
  if (provider === 'siliconflow' && model === 'moonshotai/Kimi-K2.7-Code') return {};
  if (provider === 'dashscope' && /^qwen3\.[78]-/i.test(model)) return { temperature: 0, enable_thinking: false };
  return { temperature: 0 };
}

export function assertImageModel(baseUrl: string, model: string): void {
  if (modelPreset(baseUrl, model)?.vision === false) {
    throw new Error('当前模型仅支持文本记账。识别截图请在设置中选择标有「图片／文本」的模型。');
  }
}
