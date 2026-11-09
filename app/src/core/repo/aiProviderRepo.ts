import { AI_PROVIDERS, matchProviderId } from '../aiModels';
import { db } from '../db';
import { secretStore, type SecretKey } from '../secretStore';
import { getSetting, setSetting } from './settingsRepo';

export interface AiProviderConfig {
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  threshold: number;
}
export type AiProviderDestination = Pick<AiProviderConfig, 'providerId' | 'baseUrl'>;
function assertDestination(config: AiProviderConfig, expected?: AiProviderDestination): void {
  if (expected && (config.providerId !== expected.providerId || config.baseUrl !== expected.baseUrl)) throw new Error('AI 配置已变化，请重新打开设置后重试');
}

const knownProvider = (id: string) => id === 'custom' || AI_PROVIDERS.some(p => p.id === id);
const profileKey = (id: string): SecretKey => `ai.provider.${id}`;
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

async function readActive(): Promise<AiProviderConfig> {
  const [selected, baseUrl, model, threshold] = await db.transaction('r', db.settings, () => Promise.all([
    getSetting('ai.providerId'), getSetting('ai.baseUrl'), getSetting('ai.model'), getSetting('ai.autoConfirmThreshold'),
  ]));
  const providerId = knownProvider(selected) ? selected : matchProviderId(baseUrl);
  const [rawKey, binding] = await Promise.all([secretStore.get('ai.apiKey'), secretStore.get('ai.activeCredential')]);
  let apiKey = '';
  // Settings are shared between PWA tabs; session credentials are not. Never
  // attach another tab's old key to its newly selected provider or endpoint.
  if (!binding && !selected) apiKey = rawKey || ''; // one-time pre-profile compatibility
  else if (binding) {
    try {
      const saved = JSON.parse(binding);
      if (saved.providerId === providerId && saved.baseUrl === baseUrl && saved.apiKey === rawKey) apiKey = rawKey || '';
    } catch { /* Fail closed on an invalid credential binding. */ }
  }
  return { providerId, baseUrl, model, apiKey, threshold };
}

async function bindCredential(config: Pick<AiProviderConfig, 'providerId' | 'baseUrl' | 'apiKey'>): Promise<void> {
  await secretStore.set('ai.activeCredential', JSON.stringify({ providerId: config.providerId, baseUrl: config.baseUrl, apiKey: config.apiKey }));
}

/** Key and endpoint edits explicitly rebind only this tab/device's credential. */
export function setActiveAiKey(apiKey: string, expected?: AiProviderDestination): Promise<void> {
  return serial(async () => {
    const current = await readActive();
    assertDestination(current, expected);
    await preserveLegacy(current);
    try {
      await bindCredential({ ...current, apiKey });
      if (apiKey) await secretStore.set('ai.apiKey', apiKey);
      else await secretStore.remove('ai.apiKey');
      await setSetting('ai.providerId', current.providerId);
    } catch (error) {
      await bindCredential(current);
      if (current.apiKey) await secretStore.set('ai.apiKey', current.apiKey);
      else await secretStore.remove('ai.apiKey');
      throw error;
    }
  });
}

export function setAiBaseUrl(baseUrl: string, expected?: AiProviderDestination): Promise<void> {
  return serial(async () => {
    const current = await readActive();
    assertDestination(current, expected);
    await preserveLegacy(current);
    try {
      await bindCredential({ ...current, baseUrl });
      await db.transaction('rw', db.settings, async () => {
        await setSetting('ai.baseUrl', baseUrl);
        await setSetting('ai.providerId', current.providerId);
      });
    } catch (error) { await bindCredential(current); throw error; }
  });
}

export function setAiConfigField(key: 'ai.model' | 'ai.autoConfirmThreshold', value: string | number, expected: AiProviderDestination): Promise<void> {
  return serial(async () => {
    const current = await readActive();
    assertDestination(current, expected);
    if (key === 'ai.model') await setSetting(key, String(value));
    else await setSetting(key, Number(value));
  });
}

/** Read requests only after a pending provider switch has finished. */
export function getActiveAiConfig(): Promise<AiProviderConfig> { return serial(readActive); }

/** Capture the original pre-upgrade configuration before rendering editable fields. */
export function initializeAiProviderProfiles(): Promise<AiProviderConfig> {
  return serial(async () => {
    const current = await readActive();
    if (!(await getSetting('ai.providerId'))) {
      await preserveLegacy(current);
      await bindCredential(current);
      await setSetting('ai.providerId', current.providerId);
    }
    return current;
  });
}

async function readProfile(id: string): Promise<AiProviderConfig | undefined> {
  const raw = await secretStore.get(profileKey(id));
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as Partial<AiProviderConfig>;
    if (data.providerId === id && typeof data.baseUrl === 'string' && typeof data.model === 'string'
      && typeof data.apiKey === 'string' && typeof data.threshold === 'number'
      && Number.isFinite(data.threshold) && data.threshold >= 50 && data.threshold <= 100) return data as AiProviderConfig;
  } catch { /* An invalid stored profile must never be used as credentials. */ }
}

async function preserveLegacy(current: AiProviderConfig): Promise<void> {
  if (!(await getSetting('ai.providerId')) && !(await readProfile(current.providerId)) && current.baseUrl && current.model && current.apiKey) {
    await secretStore.set(profileKey(current.providerId), JSON.stringify(current));
  }
}

/** The profile is one encrypted native value (session-only in PWA), never backup settings. */
export async function testAndSaveAiProvider(test: (config: AiProviderConfig) => Promise<unknown>, expected?: AiProviderDestination): Promise<void> {
  const candidate = await getActiveAiConfig();
  assertDestination(candidate, expected);
  await test(candidate);
  await serial(async () => {
    if (JSON.stringify(await readActive()) !== JSON.stringify(candidate)) throw new Error('AI 配置已变化，请重新测试');
    try {
      await bindCredential(candidate);
      await secretStore.set(profileKey(candidate.providerId), JSON.stringify(candidate));
      await setSetting('ai.providerId', candidate.providerId);
    }
    catch { throw new Error('连接成功，但平台配置保存失败，请重试'); }
  });
}

export function switchAiProvider(id: string): Promise<void> {
  return serial(async () => {
    if (!knownProvider(id)) throw new Error('无效的 AI 平台');
    const current = await readActive();
    if (id === current.providerId && await getSetting('ai.providerId') === id) return;
    try {
      // Preserve the pre-upgrade working configuration once. Untested edits must
      // never replace an existing successfully tested profile.
      await preserveLegacy(current);
      const preset = AI_PROVIDERS.find(p => p.id === id);
      const target = id === current.providerId ? current : await readProfile(id) ?? {
        providerId: id, baseUrl: preset?.baseUrl ?? '',
        model: preset?.models.find(m => m.tier === 'recommended')?.id ?? '',
        apiKey: '', threshold: current.threshold,
      };
      try {
        await bindCredential(target);
        if (target.apiKey) await secretStore.set('ai.apiKey', target.apiKey);
        else await secretStore.remove('ai.apiKey');
        await db.transaction('rw', db.settings, async () => {
          await setSetting('ai.providerId', target.providerId);
          await setSetting('ai.baseUrl', target.baseUrl);
          await setSetting('ai.model', target.model);
          await setSetting('ai.autoConfirmThreshold', target.threshold);
        });
      } catch (error) {
        await bindCredential(current);
        if (current.apiKey) await secretStore.set('ai.apiKey', current.apiKey);
        else await secretStore.remove('ai.apiKey');
        throw error;
      }
    } catch { throw new Error('平台切换失败，请重试'); }
  });
}
