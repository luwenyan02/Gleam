import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import capacitorConfig from '../capacitor.config';
import { nativeSpeech } from '../src/core/nativeSpeech';
import { db } from '../src/core/db';
import { exportAll, restoreAll, sanitizeDumpForBackup } from '../src/core/repo/backupRepo';

beforeEach(async () => { await db.delete(); await db.open(); });
afterEach(async () => { await db.delete(); });

it('原生桥禁止 Capacitor 自动记录 setKey 参数，debug与release一致', () => {
  expect(capacitorConfig.loggingBehavior).toBe('none');
});

it('Web语音接口没有凭据存储或麦克风回退，不接受或读回Key', async () => {
  expect(await nativeSpeech.configuration()).toEqual({ supported: false, hasKey: false, credentialRevision: '' });
  await expect(nativeSpeech.setKey({ value: 'synthetic-voice-key' })).rejects.toMatchObject({ code: 'SPEECH_UNSUPPORTED' });
  await expect(nativeSpeech.start({ sessionId: 'synthetic', expectedCredentialRevision: '', region: 'beijing', workspace: 'synthetic',
    model: 'qwen3.8-omni-flash-realtime', consent: true, userInitiated: true })).rejects.toMatchObject({ code: 'SPEECH_UNSUPPORTED' });
  expect(await db.settings.toArray()).toEqual([]);
});

it('普通备份去掉夹带的语音明文Key，恢复也不采用或保留它', async () => {
  await db.settings.put({ key: 'voice.bailian.apiKey', value: 'synthetic-private-key', updatedAt: 1 });
  const dump = await exportAll();
  expect(JSON.stringify(sanitizeDumpForBackup(dump))).not.toContain('synthetic-private-key');
  await restoreAll(dump);
  expect(await db.settings.get('voice.bailian.apiKey')).toBeUndefined();
});
