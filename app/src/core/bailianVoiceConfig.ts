import { getSetting } from './repo/settingsRepo';

export const BAILIAN_VOICE_MODEL = 'qwen3.8-omni-flash-realtime' as const;
export interface BailianVoiceConfig {
  region: 'beijing' | 'singapore';
  workspace: string;
  model: typeof BAILIAN_VOICE_MODEL;
}

export function validateBailianVoiceConfig(config: BailianVoiceConfig): BailianVoiceConfig {
  if (!['beijing', 'singapore'].includes(config.region) || config.model !== BAILIAN_VOICE_MODEL) {
    throw new Error('百炼语音地域或模型无效，请检查设置');
  }
  if (typeof config.workspace !== 'string' || (config.workspace !== '' && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(config.workspace))) {
    throw new Error('业务空间 ID 格式无效；留空可使用公网共享地址');
  }
  return { ...config };
}

export async function getBailianVoiceConfig(): Promise<BailianVoiceConfig> {
  const [region, workspace, model] = await Promise.all([
    getSetting('voice.bailian.region'), getSetting('voice.bailian.workspace'), getSetting('voice.bailian.model'),
  ]);
  return validateBailianVoiceConfig({ region, workspace: workspace.trim(), model });
}

export function bailianVoiceDestination(config: BailianVoiceConfig): string {
  const checked = validateBailianVoiceConfig(config);
  if (!checked.workspace) return checked.region === 'beijing' ? 'dashscope.aliyuncs.com' : 'dashscope-intl.aliyuncs.com';
  return `${checked.workspace}.${checked.region === 'beijing' ? 'cn-beijing' : 'ap-southeast-1'}.maas.aliyuncs.com`;
}
