/**
 * 拾光 · AI 记账平台预设（features/settings）
 * 「设置 → AI 记账」平台下拉的离线兜底清单；运行时以「获取模型列表」拉取的
 * /models 结果为准（拉取后存 'ai.recentModels' 与静态预设合并展示）。
 *
 * 收录原则：OpenAI 兼容接口 + 可直填 baseUrl（无接入点 ID 机制）+ 有视觉模型
 * （识别请求带 image_url，必须支持图片）。不内置零一万物（已停服）、
 * 火山方舟（需接入点 ID，无法用裸 baseUrl 表达）。
 */

/** 一个 AI 平台预设：下拉展示名 + OpenAI 兼容根地址 + 视觉模型兜底清单 */
export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
}

/** 静态预设仅为离线兜底，以拉取为准 */
export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'dashscope',
    name: '阿里百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-vl-plus', 'qwen-vl-max'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash-vision-exp'],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      'Qwen/Qwen2.5-VL-7B-Instruct',
      'Qwen/Qwen2.5-VL-32B-Instruct',
      'Qwen/Qwen2.5-VL-72B-Instruct',
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      'moonshot-v1-8k-vision-preview',
      'moonshot-v1-32k-vision-preview',
      'moonshot-v1-128k-vision-preview',
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5v-turbo', 'glm-4.6v-flash'],
  },
];

/**
 * 按 baseUrl 回显平台选中项：完全相等或以「预设地址 + /」开头（如 OpenAI 根地址
 * 下再拼 /v1）视为命中；匹配不上（含百炼业务空间域名等）返回 'custom'。
 */
export function matchProviderId(baseUrl: string): string {
  const u = baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  if (!u) return 'custom';
  for (const p of AI_PROVIDERS) {
    const b = p.baseUrl.toLowerCase();
    if (u === b || u.startsWith(`${b}/`)) return p.id;
  }
  return 'custom';
}
