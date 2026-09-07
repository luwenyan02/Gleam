/** 经官方模型目录与发布记录核对的离线预设；来源见 docs/ai-models.md。 */
export const MODEL_CATALOG_CHECKED_ON = '2026-09-07';
export const MODEL_CHOICE_LIMIT = 10;

export interface AiModelPreset {
  id: string;
  /** 当前可调用版本的发布／平台上架日期，不是文档更新时间。 */
  availableOn: string;
  vision: boolean;
  pinned?: boolean;
}
export interface AiProvider { id: string; name: string; baseUrl: string; models: AiModelPreset[] }
export interface ModelCache { baseUrl: string; ids: string[] }
export interface ModelChoice { value: string; label: string; group: string; note: string }

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'dashscope', name: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen3.8-max-0902', availableOn: '2026-09-02', vision: true },
      { id: 'qwen3.8-flash', availableOn: '2026-08-26', vision: true },
      { id: 'kimi-k3', availableOn: '2026-08-19', vision: true },
      { id: 'deepseek-v4-pro-0813', availableOn: '2026-08-14', vision: false },
      { id: 'deepseek-v4-flash-0731', availableOn: '2026-08-01', vision: false },
      { id: 'qwen3.7-flash', availableOn: '2026-07-21', vision: true },
      { id: 'qwen3.7-plus', availableOn: '2026-06-01', vision: true, pinned: true },
    ],
  },
  {
    id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com',
    models: [
      { id: 'gpt-6-astra', availableOn: '2026-09-03', vision: true },
      { id: 'gpt-5.6-sol', availableOn: '2026-07-09', vision: true },
      { id: 'gpt-5.6-terra', availableOn: '2026-07-09', vision: true },
      { id: 'gpt-5.6-luna', availableOn: '2026-07-09', vision: true },
    ],
  },
  {
    id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-v4-flash-vision-exp', availableOn: '2026-08-21', vision: true },
      { id: 'deepseek-v4-pro', availableOn: '2026-08-13', vision: false },
      { id: 'deepseek-v4-flash', availableOn: '2026-07-31', vision: false },
    ],
  },
  {
    id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      { id: 'zai-org/GLM-5.3', availableOn: '2026-08-14', vision: false },
      { id: 'deepseek-ai/DeepSeek-V4-Flash', availableOn: '2026-07-31', vision: false },
      { id: 'meituan-longcat/LongCat-2.0', availableOn: '2026-06-30', vision: false },
      { id: 'zai-org/GLM-5.2', availableOn: '2026-06-17', vision: false },
      { id: 'moonshotai/Kimi-K2.7-Code', availableOn: '2026-06-12', vision: true },
    ],
  },
  {
    id: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1',
    models: [{ id: 'kimi-k3', availableOn: '2026-07-16', vision: true }],
  },
  {
    id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [{ id: 'glm-5.2', availableOn: '2026-06-16', vision: false }],
  },
];

export function normalizeModelBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '').toLowerCase();
}

/** 只匹配完整地址边界；保留自定义与业务空间地址的手动输入能力。 */
export function matchProviderId(baseUrl: string): string {
  const url = normalizeModelBase(baseUrl);
  return AI_PROVIDERS.find(p => url === p.baseUrl.toLowerCase() || url.startsWith(`${p.baseUrl.toLowerCase()}/`))?.id ?? 'custom';
}

export function recentModels(providerId: string, today = new Date()): AiModelPreset[] {
  const to = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const from = new Date(to.getFullYear(), to.getMonth() - 3, 1);
  const lastDay = new Date(from.getFullYear(), from.getMonth() + 1, 0).getDate();
  from.setDate(Math.min(to.getDate(), lastDay));
  return (AI_PROVIDERS.find(p => p.id === providerId)?.models ?? [])
    .filter(model => {
      const [year, month, day] = model.availableOn.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      return date >= from && date <= to;
    })
    .sort((a, b) => b.availableOn.localeCompare(a.availableOn))
    .slice(0, MODEL_CHOICE_LIMIT);
}

export function modelPreset(baseUrl: string, id: string): AiModelPreset | undefined {
  return AI_PROVIDERS.find(p => p.id === matchProviderId(baseUrl))?.models.find(m => m.id.toLowerCase() === id.toLowerCase());
}

/** 当前配置优先保留；缓存只能用于原接口，旧版无来源缓存不自动沿用。 */
export function buildModelChoices(baseUrl: string, current: string, cache: ModelCache | null, today = new Date()): ModelChoice[] {
  const pid = matchProviderId(baseUrl);
  const provider = AI_PROVIDERS.find(p => p.id === pid);
  const describe = (model: AiModelPreset, group: string): ModelChoice => ({
    value: model.id, label: model.id, group,
    note: `${model.availableOn} · ${model.vision ? '图片／文本' : '仅文本'}`,
  });
  const recent = recentModels(pid, today);
  const choices = recent.map(model => describe(model, '近三个月发布／上架'));
  for (const model of provider?.models ?? []) {
    if (model.pinned && !recent.some(m => m.id === model.id)) choices.push(describe(model, '指定保留 · 非近期预设'));
  }
  if (cache && normalizeModelBase(cache.baseUrl) === normalizeModelBase(baseUrl)) {
    for (const id of cache.ids) choices.push({ value: id, label: id, group: '接口返回', note: '日期与图片能力未核验' });
  }
  if (current && !choices.some(choice => choice.value === current)) {
    choices.unshift({ value: current, label: current, group: '当前配置', note: '已保存 · 日期与图片能力未核验' });
  } else if (current) {
    const index = choices.findIndex(choice => choice.value === current);
    if (index >= MODEL_CHOICE_LIMIT) choices.unshift(choices.splice(index, 1)[0]);
  }
  return choices.filter((choice, index) => choices.findIndex(other => other.value === choice.value) === index).slice(0, MODEL_CHOICE_LIMIT);
}
