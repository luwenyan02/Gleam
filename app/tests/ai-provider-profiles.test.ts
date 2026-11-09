import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../src/core/db';
import { secretStore } from '../src/core/secretStore';
import { getSetting, setSetting } from '../src/core/repo/settingsRepo';
import { AI_PROVIDERS } from '../src/core/aiModels';
import { getActiveAiConfig, initializeAiProviderProfiles, setActiveAiKey, setAiBaseUrl, switchAiProvider, testAndSaveAiProvider } from '../src/core/repo/aiProviderRepo';
import { testAiConnection } from '../src/core/repo/aiRepo';

const base = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const original = { baseUrl: base, model: 'fixture-original-model', apiKey: 'fixture-original-key', threshold: 90 };
const verify = vi.fn(async () => {});
async function edit(model: string, apiKey: string) {
  await initializeAiProviderProfiles();
  await setSetting('ai.model', model);
  await setActiveAiKey(apiKey);
}
beforeEach(async () => {
  await db.delete(); await db.open();
  await secretStore.remove('ai.activeCredential');
  for (const id of ['custom', ...AI_PROVIDERS.map(p => p.id)]) await secretStore.remove(`ai.provider.${id}`);
  await setSetting('ai.baseUrl', original.baseUrl);
  await setSetting('ai.model', original.model);
  await setSetting('ai.autoConfirmThreshold', original.threshold);
  await secretStore.set('ai.apiKey', original.apiKey);
  verify.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('migrates the existing configuration intact, and a new provider never inherits its credentials', async () => {
  await switchAiProvider('openai');
  expect(await getActiveAiConfig()).toMatchObject({ providerId: 'openai', baseUrl: 'https://api.openai.com', apiKey: '', threshold: 90 });
  await switchAiProvider('dashscope');
  expect(await getActiveAiConfig()).toEqual({ providerId: 'dashscope', ...original });
});
it('restores each provider’s latest successfully tested endpoint, model, key and threshold', async () => {
  await testAndSaveAiProvider(verify);
  await switchAiProvider('openai');
  await edit('fixture-openai-model', 'fixture-openai-key');
  await setSetting('ai.autoConfirmThreshold', 85);
  await testAndSaveAiProvider(verify);
  await switchAiProvider('dashscope');
  await edit('fixture-new-bailian-model', 'fixture-new-bailian-key');
  await testAndSaveAiProvider(verify);
  await switchAiProvider('openai');
  expect(await getActiveAiConfig()).toMatchObject({ model: 'fixture-openai-model', apiKey: 'fixture-openai-key', threshold: 85 });
  await switchAiProvider('dashscope');
  expect(await getActiveAiConfig()).toMatchObject({ model: 'fixture-new-bailian-model', apiKey: 'fixture-new-bailian-key', threshold: 90 });
  expect(verify).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'fixture-new-bailian-model', apiKey: 'fixture-new-bailian-key' }));
});
it('keeps the last working profile after a failed test or an untested edit', async () => {
  await testAndSaveAiProvider(verify);
  await edit('fixture-failed-model', 'fixture-failed-key');
  await expect(testAndSaveAiProvider(async () => { throw new Error('认证失败'); })).rejects.toThrow('认证失败');
  await switchAiProvider('openai'); await switchAiProvider('dashscope');
  expect(await getActiveAiConfig()).toEqual({ providerId: 'dashscope', ...original });
});
it('refuses a late test result if configuration changed during the request', async () => {
  await testAndSaveAiProvider(verify);
  await expect(testAndSaveAiProvider(async () => { await edit('fixture-other-model', 'fixture-other-key'); })).rejects.toThrow('配置已变化');
  await switchAiProvider('openai'); await switchAiProvider('dashscope');
  expect(await getActiveAiConfig()).toEqual({ providerId: 'dashscope', ...original });
});
it('does not let a late result save credentials into a newly selected platform', async () => {
  await testAndSaveAiProvider(verify);
  await expect(testAndSaveAiProvider(async () => { await switchAiProvider('deepseek'); })).rejects.toThrow('配置已变化');
  expect(await getActiveAiConfig()).toMatchObject({ providerId: 'deepseek', apiKey: '' });
  await switchAiProvider('dashscope');
  expect(await getActiveAiConfig()).toMatchObject(original);
});
it('supports a custom endpoint as a separate profile, retaining its explicit provider choice', async () => {
  await switchAiProvider('custom');
  await setAiBaseUrl(base);
  await edit('fixture-custom-model', 'fixture-custom-key');
  await testAndSaveAiProvider(verify);
  await switchAiProvider('dashscope'); await switchAiProvider('custom');
  expect(await getActiveAiConfig()).toMatchObject({ providerId: 'custom', baseUrl: base, model: 'fixture-custom-model', apiKey: 'fixture-custom-key' });
});
it('selecting the initially inferred custom platform makes the choice explicit', async () => {
  await setSetting('ai.baseUrl', 'https://fixture-custom.invalid/v1');
  await switchAiProvider('custom');
  await setAiBaseUrl(base);
  expect(await getActiveAiConfig()).toMatchObject({ providerId: 'custom', baseUrl: base, apiKey: original.apiKey });
});
it('never writes provider credentials to settings or backup material', async () => {
  await testAndSaveAiProvider(verify);
  expect(JSON.stringify(await db.settings.toArray())).not.toContain(original.apiKey);
  expect(await secretStore.get('ai.provider.dashscope')).toContain(original.apiKey);
});
it('leaves the current configuration intact if restoring a provider key fails', async () => {
  await testAndSaveAiProvider(verify);
  const set = vi.spyOn(secretStore, 'remove').mockRejectedValueOnce(new Error('fixture-native-error-with-private-content'));
  await expect(switchAiProvider('openai')).rejects.toThrow('切换失败');
  expect(await getActiveAiConfig()).toEqual({ providerId: 'dashscope', ...original });
  set.mockRestore();
});
it('invalid provider identifiers cannot create arbitrary secure storage keys', async () => {
  await expect(switchAiProvider('__proto__')).rejects.toThrow('平台');
  expect(await getActiveAiConfig()).toMatchObject(original);
});
it('does not preserve failed settings on a previously unconfigured platform', async () => {
  await switchAiProvider('openai');
  await edit('fixture-invalid-model', 'fixture-invalid-key');
  await expect(testAndSaveAiProvider(async () => { throw new Error('认证失败'); })).rejects.toThrow();
  await switchAiProvider('dashscope'); await switchAiProvider('openai');
  expect(await getActiveAiConfig()).toMatchObject({ providerId: 'openai', apiKey: '' });
});
it('connection validation sends exactly the captured provider, model and credential', async () => {
  const candidate = await getActiveAiConfig();
  await switchAiProvider('openai');
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
  vi.stubGlobal('fetch', fetch);
  await testAiConnection(candidate);
  const [url, request] = fetch.mock.calls[0];
  expect(url).toBe(`${base}/chat/completions`);
  expect(request.headers.Authorization).toBe(`Bearer ${original.apiKey}`);
  expect(JSON.parse(request.body).model).toBe(original.model);
});
it('switches every built-in provider independently and restores the tested credentials', async () => {
  for (const provider of AI_PROVIDERS) {
    await switchAiProvider(provider.id);
    await edit(`fixture-${provider.id}-model`, `fixture-${provider.id}-key`);
    await testAndSaveAiProvider(verify);
  }
  for (const provider of AI_PROVIDERS) {
    await switchAiProvider(provider.id);
    expect(await getActiveAiConfig()).toMatchObject({ providerId: provider.id, baseUrl: provider.baseUrl,
      model: `fixture-${provider.id}-model`, apiKey: `fixture-${provider.id}-key` });
  }
});
it('rolls back the active key if saving the new active settings fails', async () => {
  await testAndSaveAiProvider(verify);
  const put = vi.spyOn(db.settings, 'put').mockRejectedValueOnce(new Error('fixture-db-error'));
  await expect(switchAiProvider('openai')).rejects.toThrow('切换失败');
  expect(await getActiveAiConfig()).toEqual({ providerId: 'dashscope', ...original });
  put.mockRestore();
});
it('rejects a key from another PWA tab when its shared provider or endpoint changed', async () => {
  await testAndSaveAiProvider(verify);
  // Another tab modifies shared settings, but cannot modify our sessionStorage.
  await setSetting('ai.providerId', 'openai');
  await setSetting('ai.baseUrl', 'https://api.openai.com');
  expect(await getActiveAiConfig()).toMatchObject({ providerId: 'openai', apiKey: '' });
  await setSetting('ai.providerId', 'dashscope');
  await setSetting('ai.baseUrl', 'https://fixture-other-bailian.invalid/v1');
  expect(await getActiveAiConfig()).toMatchObject({ providerId: 'dashscope', apiKey: '' });
});
it('an unopened legacy tab cannot attach its unbound key after another tab switches provider', async () => {
  await setSetting('ai.providerId', 'openai');
  await setSetting('ai.baseUrl', 'https://api.openai.com');
  expect(await secretStore.get('ai.apiKey')).toBe(original.apiKey);
  expect(await getActiveAiConfig()).toMatchObject({ providerId: 'openai', apiKey: '' });
});
it('a native key write that mutates and then rejects restores the previous complete active configuration', async () => {
  await switchAiProvider('openai');
  await edit('fixture-openai-model', 'fixture-openai-key');
  await testAndSaveAiProvider(verify);
  await switchAiProvider('dashscope');
  const realSet = secretStore.set.bind(secretStore);
  vi.spyOn(secretStore, 'set').mockImplementation(async (key, value) => {
    await realSet(key, value);
    if (key === 'ai.apiKey' && value === 'fixture-openai-key') throw new Error('fixture-half-successful-native-write');
  });
  await expect(switchAiProvider('openai')).rejects.toThrow('切换失败');
  expect(await getActiveAiConfig()).toEqual({ providerId: 'dashscope', ...original });
});
it('failed rollback cannot expose a mismatched key to the previous endpoint', async () => {
  await switchAiProvider('openai');
  await edit('fixture-openai-model', 'fixture-openai-key');
  await testAndSaveAiProvider(verify);
  await switchAiProvider('dashscope');
  const realSet = secretStore.set.bind(secretStore);
  let failed = false;
  vi.spyOn(secretStore, 'set').mockImplementation(async (key, value) => {
    if (failed) throw new Error('fixture-storage-unavailable');
    await realSet(key, value);
    if (key === 'ai.apiKey' && value === 'fixture-openai-key') { failed = true; throw new Error('fixture-native-commit-failure'); }
  });
  await expect(switchAiProvider('openai')).rejects.toThrow('切换失败');
  expect(await getActiveAiConfig()).toMatchObject({ providerId: 'dashscope', baseUrl: base, apiKey: '' });
});
it('a stale settings form cannot rebind a newly typed key or test to another tab’s platform', async () => {
  const rendered = await initializeAiProviderProfiles();
  await setSetting('ai.providerId', 'openai'); await setSetting('ai.baseUrl', 'https://api.openai.com');
  await expect(setActiveAiKey('fixture-key-typed-for-bailian', rendered)).rejects.toThrow('配置已变化');
  await expect(setAiBaseUrl('https://fixture-edit.invalid', rendered)).rejects.toThrow('配置已变化');
  await expect(testAndSaveAiProvider(verify, rendered)).rejects.toThrow('配置已变化');
  expect(verify).not.toHaveBeenCalled();
  expect(await secretStore.get('ai.apiKey')).toBe(original.apiKey);
});
it('manual endpoint changes end legacy compatibility so an unopened tab fails closed', async () => {
  await setAiBaseUrl('https://fixture-other.invalid/v1');
  expect(await getSetting('ai.providerId')).toBe('dashscope');
  await secretStore.remove('ai.activeCredential'); // another tab still has only its pre-upgrade key
  expect(await getActiveAiConfig()).toMatchObject({ apiKey: '' });
});
