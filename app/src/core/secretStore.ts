import { Capacitor, registerPlugin } from '@capacitor/core';
import { getSetting, setSetting } from './repo/settingsRepo';

export type SecretKey =
  | 'ai.apiKey'
  | 'cloud.webdav.password'
  | 'cloud.email.token'
  | 'cloud.s3.accessKey'
  | 'cloud.s3.secretKey';

export interface SecretStore {
  readonly kind: 'android-keystore' | 'session';
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  remove(key: SecretKey): Promise<void>;
}

interface NativeSecretsPlugin {
  get(options: { key: SecretKey }): Promise<{ value: string | null }>;
  set(options: { key: SecretKey; value: string }): Promise<void>;
  remove(options: { key: SecretKey }): Promise<void>;
}

const NativeSecrets = registerPlugin<NativeSecretsPlugin>('GleamSecrets');
const SESSION_PREFIX = 'gleam-secret:';

/** PWA 实现：只使用 sessionStorage，关闭标签页后自动清除。 */
export class SessionSecretStore implements SecretStore {
  readonly kind = 'session' as const;

  constructor(private readonly storage: Storage) {}

  async get(key: SecretKey): Promise<string | null> {
    return this.storage.getItem(`${SESSION_PREFIX}${key}`);
  }

  async set(key: SecretKey, value: string): Promise<void> {
    if (!value) { await this.remove(key); return; }
    this.storage.setItem(`${SESSION_PREFIX}${key}`, value);
  }

  async remove(key: SecretKey): Promise<void> {
    this.storage.removeItem(`${SESSION_PREFIX}${key}`);
  }
}

class AndroidSecretStore implements SecretStore {
  readonly kind = 'android-keystore' as const;

  async get(key: SecretKey): Promise<string | null> {
    const result = await NativeSecrets.get({ key });
    return result.value || null;
  }

  async set(key: SecretKey, value: string): Promise<void> {
    if (!value) { await this.remove(key); return; }
    await NativeSecrets.set({ key, value });
  }

  async remove(key: SecretKey): Promise<void> {
    await NativeSecrets.remove({ key });
  }
}

class MemorySessionStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function runtimeSessionStorage(): Storage {
  return typeof window !== 'undefined' && window.sessionStorage
    ? window.sessionStorage
    : new MemorySessionStorage();
}

export const secretStore: SecretStore = Capacitor.isNativePlatform()
  ? new AndroidSecretStore()
  : new SessionSecretStore(runtimeSessionStorage());

export interface LegacySecretBundle {
  aiApiKey?: string;
  webdavPassword?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
}

const LEGACY_SECRET_KEYS: { field: keyof LegacySecretBundle; key: SecretKey }[] = [
  { field: 'aiApiKey', key: 'ai.apiKey' },
  { field: 'webdavPassword', key: 'cloud.webdav.password' },
  { field: 's3AccessKey', key: 'cloud.s3.accessKey' },
  { field: 's3SecretKey', key: 'cloud.s3.secretKey' },
];

/** 可独立测试的迁移核心；结果只包含键名，不回显任何凭据内容。 */
export async function migrateSecretBundle(
  legacy: LegacySecretBundle,
  store: SecretStore,
): Promise<{ migrated: number; failed: SecretKey[] }> {
  let migrated = 0;
  const failed: SecretKey[] = [];
  for (const { field, key } of LEGACY_SECRET_KEYS) {
    const value = legacy[field]?.trim();
    if (!value) continue;
    try {
      if (!(await store.get(key))) {
        await store.set(key, value);
        migrated += 1;
      }
    } catch {
      failed.push(key);
    }
  }
  return { migrated, failed };
}

/**
 * 将旧 settings KV 中的明文凭据迁移一次。无论个别写入是否成功，都会清空旧明文；
 * 失败键由调用方提示用户重新输入，避免明文继续滞留 IndexedDB。
 */
export async function migrateLegacySecrets(): Promise<{ migrated: number; failed: SecretKey[] }> {
  if (await getSetting('security.secretsMigrated')) return { migrated: 0, failed: [] };
  const [aiApiKey, webdav, s3] = await Promise.all([
    getSetting('ai.apiKey'),
    getSetting('cloud.webdav'),
    getSetting('cloud.s3'),
  ]);
  const result = await migrateSecretBundle({
    aiApiKey,
    webdavPassword: webdav.password,
    s3AccessKey: s3.accessKey,
    s3SecretKey: s3.secretKey,
  }, secretStore);

  await Promise.all([
    setSetting('ai.apiKey', ''),
    setSetting('cloud.webdav', { ...webdav, password: '' }),
    setSetting('cloud.s3', { ...s3, accessKey: '', secretKey: '' }),
  ]);
  await setSetting('security.secretsMigrated', true);
  return result;
}
