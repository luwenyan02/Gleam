/** 经官方模型目录与发布记录核对的离线预设；来源见 docs/ai-models.md。 */
export const MODEL_CATALOG_CHECKED_ON = '2026-10-22';

export interface AiModelPreset {
  id: string;
  /** 当前可调用版本的发布／平台上架日期，不是文档更新时间。 */
  availableOn?: string;
  /** 独立记录版本更新日期，不覆盖首次发布／上架日期。 */
  updatedOn?: string;
  tier?: 'recommended' | 'legacy';
  note?: string;
  vision: boolean;
}
export interface AiProvider { id: string; name: string; baseUrl: string; models: AiModelPreset[] }
export interface ModelCache { baseUrl: string; ids: string[] }
export interface ModelChoice { value: string; label: string; group: string; note: string }

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'dashscope', name: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'deepseek-v4.1-flash-1017', tier: 'recommended', availableOn: '2026-10-17', vision: true },
      { id: 'qwen3.8-max-0902', availableOn: '2026-09-02', vision: true },
      { id: 'qwen3.8-flash', tier: 'recommended', availableOn: '2026-08-26', vision: true },
      { id: 'kimi-k3', availableOn: '2026-08-19', vision: true },
      { id: 'qwen3.7-flash', availableOn: '2026-07-21', vision: true },
    ],
  },
  {
    id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com',
    models: [
      { id: 'gpt-6.1-sol', availableOn: '2026-09-29', vision: true, tier: 'recommended' },
      { id: 'gpt-6-luna', availableOn: '2026-09-22', vision: true, tier: 'recommended' },
      { id: 'gpt-6-sol', availableOn: '2026-09-22', vision: true },
      { id: 'gpt-6-astra', availableOn: '2026-09-03', vision: true },
      { id: 'gpt-5.6-sol', tier: 'legacy', availableOn: '2026-07-09', vision: true },
      { id: 'gpt-5.6-terra', tier: 'legacy', availableOn: '2026-07-09', vision: true },
      { id: 'gpt-5.6-luna', tier: 'legacy', availableOn: '2026-07-09', vision: true },
    ],
  },
  {
    id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-flash', availableOn: '2026-09-10', updatedOn: '2026-10-17', vision: true, tier: 'recommended' },
      { id: 'deepseek-v4-flash-vision-exp', availableOn: '2026-08-21', vision: true, tier: 'legacy', note: '旧名转向 V4.1 Flash' },
      { id: 'deepseek-v4-pro', availableOn: '2026-08-13', vision: false },
      { id: 'deepseek-v4-flash', availableOn: '2026-07-31', vision: true, tier: 'legacy', note: '旧名转向 V4.1 Flash' },
    ],
  },
  {
    id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash', availableOn: '2026-09-10', vision: true, tier: 'recommended', note: '已更新至 1017 版' },
      { id: 'zai-org/GLM-5.3-Flash', availableOn: '2026-08-26', vision: true, tier: 'recommended' },
      { id: 'Qwen/Qwen3.8-27B', availableOn: '2026-08-14', vision: true },
      { id: 'zai-org/GLM-5.3', availableOn: '2026-08-14', vision: false },
      { id: 'deepseek-ai/DeepSeek-V4-Flash', tier: 'legacy', availableOn: '2026-07-31', vision: false },
      { id: 'meituan-longcat/LongCat-2.0', tier: 'legacy', availableOn: '2026-06-30', vision: false },
      { id: 'zai-org/GLM-5.2', tier: 'legacy', availableOn: '2026-06-17', vision: false },
      { id: 'moonshotai/Kimi-K2.7-Code', tier: 'legacy', availableOn: '2026-06-12', vision: true },
    ],
  },
  {
    id: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'kimi-k3', availableOn: '2026-07-16', vision: true, tier: 'recommended' },
      { id: 'kimi-k2.7-code', vision: true, tier: 'legacy', note: '编程型号' },
      { id: 'kimi-k2.7-code-highspeed', vision: true, tier: 'legacy', note: 'K2.7 编程高速版' },
      { id: 'kimi-k2.6', vision: true, tier: 'legacy' },
    ],
  },
  {
    id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-5.3-flash', availableOn: '2026-08-26', vision: true, tier: 'recommended' },
      { id: 'glm-5.3-flashx', vision: true, tier: 'recommended' },
      { id: 'glm-5.3', availableOn: '2026-08-19', vision: false },
      { id: 'glm-5.2', availableOn: '2026-06-16', vision: false, tier: 'legacy' },
    ],
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
      const available = model.updatedOn ?? model.availableOn;
      if (!available) return false;
      const [year, month, day] = available.split('-').map(Number);
      const date = new Date(year, month - 1, day);
      return date >= from && date <= to;
    })
    .sort((a, b) => (b.updatedOn ?? b.availableOn ?? '').localeCompare(a.updatedOn ?? a.availableOn ?? ''));
}

export function modelPreset(baseUrl: string, id: string): AiModelPreset | undefined {
  return AI_PROVIDERS.find(p => p.id === matchProviderId(baseUrl))?.models.find(m => m.id.toLowerCase() === id.toLowerCase());
}

/** 当前配置优先保留；推荐不因三个月期限消失，接口缓存只能用于原地址。 */
export function buildModelChoices(baseUrl: string, current: string, cache: ModelCache | null, today = new Date()): ModelChoice[] {
  const pid = matchProviderId(baseUrl);
  const provider = AI_PROVIDERS.find(p => p.id === pid);
  const describe = (model: AiModelPreset, group: string): ModelChoice => ({
    value: model.id, label: model.id, group,
    note: [model.updatedOn ? `${model.updatedOn} 更新` : model.availableOn,
      model.vision ? '图片／文本' : '仅文本', model.note].filter(Boolean).join(' · '),
  });
  const recent = new Set(recentModels(pid, today).map(model => model.id));
  const choices: ModelChoice[] = [];
  const currentPreset = modelPreset(baseUrl, current);
  if (current) choices.push(currentPreset ? { ...describe(currentPreset, '当前配置'), value: current, label: current }
    : { value: current, label: current, group: '当前配置', note: '已保存 · 日期与图片能力未核验' });
  const groups = ['推荐模型', '近期更新', '兼容旧版'];
  for (const group of groups) {
    for (const model of provider?.models ?? []) {
      const category = model.tier === 'recommended' ? groups[0]
        : model.tier === 'legacy' || !recent.has(model.id) ? groups[2] : groups[1];
      if (category === group) choices.push(describe(model, group));
    }
  }
  if (cache && normalizeModelBase(cache.baseUrl) === normalizeModelBase(baseUrl)) {
    for (const id of cache.ids) choices.push({ value: id, label: id, group: '接口返回', note: '日期与图片能力未核验' });
  }
  // No display cap: the picker searches every fetched candidate, including the tail.
  const seen = new Set<string>();
  return choices.filter(choice => {
    if (seen.has(choice.value)) return false;
    seen.add(choice.value); return true;
  });
}
