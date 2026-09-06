import { describe, expect, it } from 'vitest';
import {
  SessionSecretStore,
  migrateSecretBundle,
  type SecretStore,
} from '../src/core/secretStore';

function fakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('SecretStore', () => {
  it('PWA 默认只写当前会话存储并支持删除', async () => {
    const storage = fakeStorage();
    const store = new SessionSecretStore(storage);
    await store.set('ai.apiKey', 'demo-key');
    expect(await store.get('ai.apiKey')).toBe('demo-key');
    await store.remove('ai.apiKey');
    expect(await store.get('ai.apiKey')).toBeNull();
  });

  it('一次迁移会写入安全存储并报告失败项，不在结果中回显密钥', async () => {
    const values = new Map<string, string>();
    const store: SecretStore = {
      kind: 'session',
      async get(key) { return values.get(key) ?? null; },
      async set(key, value) {
        if (key === 'cloud.s3.secretKey') throw new Error('write failed');
        values.set(key, value);
      },
      async remove(key) { values.delete(key); },
    };

    const result = await migrateSecretBundle({
      aiApiKey: 'ai-secret',
      webdavPassword: 'dav-secret',
      s3AccessKey: 'access-secret',
      s3SecretKey: 's3-secret',
    }, store);

    expect(await store.get('ai.apiKey')).toBe('ai-secret');
    expect(await store.get('cloud.webdav.password')).toBe('dav-secret');
    expect(result).toEqual({ migrated: 3, failed: ['cloud.s3.secretKey'] });
    expect(JSON.stringify(result)).not.toContain('s3-secret');
  });
});
