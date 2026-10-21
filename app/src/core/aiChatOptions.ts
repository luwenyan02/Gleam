import { matchProviderId, modelPreset } from './aiModels';

/** 只修正已确认的参数不兼容，其余模型保留原先的低随机性。 */
export function chatOptions(baseUrl: string, model: string): Record<string, unknown> {
  const provider = matchProviderId(baseUrl);
  if (provider === 'openai' && /^gpt-(5\.6|6)/i.test(model)) return { reasoning_effort: 'low' };
  if ((provider === 'moonshot' || provider === 'dashscope') && model === 'kimi-k3') return { reasoning_effort: 'low' };
  if (provider === 'moonshot' && /^kimi-k2\.7-code(?:-highspeed)?$/.test(model)) return {};
  if (provider === 'moonshot' && model === 'kimi-k2.6') return { thinking: { type: 'disabled' } };
  if (provider === 'deepseek' && /^(?:deepseek-flash|deepseek-v4-(?:pro|flash|flash-vision-exp))$/.test(model)) return { temperature: 0, thinking: { type: 'disabled' } };
  // GLM-5.3 uses provider defaults; Flash/FlashX cannot disable thinking.
  if (provider === 'zhipu' && /^glm-5\.3(?:-flashx?)?$/.test(model)) return {};
  if (provider === 'siliconflow' && model === 'moonshotai/Kimi-K2.7-Code') return {};
  if (provider === 'dashscope' && /^qwen3\.[78]-/i.test(model)) return { temperature: 0, enable_thinking: false };
  return { temperature: 0 };
}

export function assertImageModel(baseUrl: string, model: string): void {
  if (modelPreset(baseUrl, model)?.vision === false) {
    throw new Error('当前模型仅支持文本记账。识别截图请在设置中选择标有「图片／文本」的模型。');
  }
}
