import { afterEach, expect, it, vi } from 'vitest';
import { BailianVoiceCandidateTest } from '../src/core/bailianVoiceCandidateTest';
import { BailianVoiceConnectionTest } from '../src/core/bailianVoiceConnectionTest';
import { BailianVoiceSession } from '../src/core/bailianVoiceSession';
import { BAILIAN_VOICE_MODEL } from '../src/core/bailianVoiceConfig';
import type { NativeSpeechPlugin } from '../src/core/nativeSpeech';

const config = { region: 'beijing' as const, workspace: 'synthetic', model: BAILIAN_VOICE_MODEL };
const readiness = {
  supported: true, hasKey: true, credentialRevision: 'voice-before',
  keySource: 'separate' as const, maskedKey: '••••••',
  hasMainKey: true, mainCredentialRevision: 'main-before',
};
const candidate = { keySource: 'separate' as const, value: 'synthetic-candidate-key', configurationId: 'config-before' };
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const tests: ReturnType<typeof deferred>[] = [];
  const commits: ReturnType<typeof deferred>[] = [];
  const bridge = {
    testCandidate: vi.fn(() => { const pending = deferred(); tests.push(pending); return pending.promise; }),
    commitTestedKey: vi.fn(() => { const pending = deferred(); commits.push(pending); return pending.promise; }),
    testConnection: vi.fn(), start: vi.fn(), stop: vi.fn(), setKey: vi.fn(), clearKey: vi.fn(),
    cancel: vi.fn(async () => {}), addListener: vi.fn(async () => ({ remove: vi.fn(async () => {}) })),
  } as unknown as NativeSpeechPlugin;
  const changed = vi.fn();
  const committed = vi.fn();
  const controller = new BailianVoiceCandidateTest(bridge, changed, committed);
  const id = () => vi.mocked(bridge.testCandidate).mock.calls.at(-1)![0].sessionId;
  const ack = (overrides: Record<string, unknown> = {}) => ({
    ...readiness, credentialRevision: 'voice-after', activeConfig: { ...config }, ...overrides,
  });
  async function connected(index = tests.length - 1, sessionId = id()) {
    tests[index].resolve({ sessionId, connected: true, candidateToken: `tested-${index}` });
    await Promise.resolve();
    await Promise.resolve();
  }
  return { controller, bridge, changed, committed, tests, commits, id, ack, connected };
}
afterEach(() => vi.useRealTimers());

it('cancellation before a late connection result prevents any commit, including after a newer start', async () => {
  const s = setup();
  const first = s.controller.start(config, readiness, candidate);
  const oldId = s.id();
  s.controller.invalidate();
  expect(s.bridge.cancel).toHaveBeenCalledWith({ sessionId: oldId });
  const second = s.controller.start(config, readiness, { ...candidate, configurationId: 'config-new' });
  const newId = s.id();
  await s.connected(0, oldId);
  await first;
  expect(s.bridge.commitTestedKey).not.toHaveBeenCalled();
  expect(s.controller.state).toBe('testing');
  await s.connected(1, newId);
  expect(s.bridge.commitTestedKey).toHaveBeenCalledOnce();
  expect(s.bridge.commitTestedKey).toHaveBeenCalledWith({
    sessionId: newId, candidateToken: 'tested-1', configurationId: 'config-new',
    expectedCredentialRevision: 'voice-before', expectedMainCredentialRevision: 'main-before',
  });
  s.commits[0].resolve(s.ack());
  await second;
  expect(s.controller.state).toBe('success');
  expect(s.committed).toHaveBeenCalledOnce();
});

it('cancellation during commit discards the session and ignores a late storage acknowledgement', async () => {
  const s = setup();
  const first = s.controller.start(config, readiness, candidate);
  const oldId = s.id();
  await s.connected();
  expect(s.controller.busy).toBe(true);
  expect(s.controller.state).toBe('testing');
  expect(s.committed).not.toHaveBeenCalled();
  s.controller.invalidate();
  const second = s.controller.start(config, readiness, { ...candidate, configurationId: 'config-new' });
  s.commits[0].resolve(s.ack());
  await first;
  expect(s.bridge.cancel).toHaveBeenCalledWith({ sessionId: oldId });
  expect(s.controller.state).toBe('testing');
  expect(s.committed).not.toHaveBeenCalled();
  await s.connected();
  s.commits[1].resolve(s.ack({ credentialRevision: 'voice-new' }));
  await second;
  expect(s.controller.state).toBe('success');
  expect(s.committed).toHaveBeenCalledOnce();
});

it('only explicit candidate testing and successful safe storage acknowledgement can report success', async () => {
  const s = setup();
  expect(s.bridge.testCandidate).not.toHaveBeenCalled();
  const run = s.controller.start(config, readiness, candidate);
  await s.controller.start(config, readiness, candidate);
  expect(s.bridge.testCandidate).toHaveBeenCalledOnce();
  expect(s.bridge.testCandidate).toHaveBeenCalledWith({
    ...config, ...candidate, sessionId: s.id(), expectedCredentialRevision: 'voice-before',
    expectedMainCredentialRevision: 'main-before', consent: true, userInitiated: true,
  });
  expect(JSON.stringify(s.controller, (key, value) => key === 'timer' ? undefined : value)).not.toContain(candidate.value);
  await s.connected();
  expect(s.controller.state).toBe('testing');
  expect(s.controller.message).not.toContain('连接通过');
  expect(s.controller.busy).toBe(true);
  const result = s.ack({ rawSecret: 'SYNTHETIC_PRIVATE_SECRET', activeConfig: { ...config, secret: 'SYNTHETIC_PRIVATE_SECRET' } });
  s.commits[0].resolve(result);
  await run;
  expect(s.controller.state).toBe('success');
  expect(s.controller.busy).toBe(false);
  expect(s.controller.message).not.toContain('已保存');
  expect(s.controller.message).toContain('录音未测试');
  expect(s.committed).toHaveBeenCalledExactlyOnceWith(s.ack());
  expect(JSON.stringify(s.committed.mock.calls)).not.toContain('SYNTHETIC_PRIVATE');
  expect(s.bridge.start).not.toHaveBeenCalled();
  expect(s.bridge.stop).not.toHaveBeenCalled();
  expect(s.bridge.addListener).not.toHaveBeenCalled();
  expect(s.bridge.setKey).not.toHaveBeenCalled();
  expect(s.bridge.clearKey).not.toHaveBeenCalled();
  expect(s.bridge.testConnection).not.toHaveBeenCalled();
});

it('shared keys require an available main key, never forward an unrelated raw draft, and commit the shared source', async () => {
  const s = setup();
  const shared = { ...candidate, keySource: 'shared' as const };
  await s.controller.start(config, { ...readiness, hasMainKey: false }, shared);
  expect(s.bridge.testCandidate).not.toHaveBeenCalled();
  const run = s.controller.start(config, readiness, shared);
  expect(vi.mocked(s.bridge.testCandidate).mock.calls[0][0]).not.toHaveProperty('value');
  await s.connected();
  s.commits[0].resolve(s.ack({ keySource: 'shared' }));
  await run;
  expect(s.controller.state).toBe('success');
});

it('a separate stored key can be retested without a draft, but a missing separate key cannot', async () => {
  const s = setup();
  const stored = { keySource: 'separate' as const, configurationId: 'config-before' };
  await s.controller.start(config, { ...readiness, hasKey: false }, stored);
  await s.controller.start(config, { ...readiness, keySource: 'shared' }, stored);
  expect(s.bridge.testCandidate).not.toHaveBeenCalled();
  const run = s.controller.start(config, readiness, stored);
  expect(vi.mocked(s.bridge.testCandidate).mock.calls[0][0]).not.toHaveProperty('value');
  await s.connected();
  s.commits[0].resolve(s.ack());
  await run;
  expect(s.controller.state).toBe('success');
});

it.each([
  ['unsupported', { supported: false }, {}, {}],
  ['invalid workspace', {}, { workspace: 'bad/path' }, {}],
  ['empty voice revision', { credentialRevision: '' }, {}, {}],
  ['bad voice revision', { credentialRevision: '\nPRIVATE' }, {}, {}],
  ['empty main revision', { mainCredentialRevision: '' }, {}, {}],
  ['missing source', {}, {}, { keySource: undefined }],
  ['bad source', {}, {}, { keySource: 'other' }],
  ['empty configuration ID', {}, {}, { configurationId: '' }],
  ['oversized configuration ID', {}, {}, { configurationId: 'x'.repeat(129) }],
  ['non-string key', {}, {}, { value: 42 }],
] as const)('invalid local %s never dispatches candidate credentials', async (_label, state, settings, draft) => {
  const s = setup();
  await s.controller.start({ ...config, ...settings }, { ...readiness, ...state }, { ...candidate, ...draft } as typeof candidate);
  expect(s.bridge.testCandidate).not.toHaveBeenCalled();
  expect(s.bridge.commitTestedKey).not.toHaveBeenCalled();
  expect(s.controller.state).toBe('error');
  expect(s.controller.message).not.toContain('PRIVATE');
});

it.each([
  () => null,
  () => [],
  () => ({ connected: true, candidateToken: 'tested-token' }),
  () => ({ sessionId: 42, connected: true, candidateToken: 'tested-token' }),
  () => ({ sessionId: 'wrong-session', connected: true, candidateToken: 'tested-token' }),
  (id: string) => ({ sessionId: id, candidateToken: 'tested-token' }),
  (id: string) => ({ sessionId: id, connected: 'true', candidateToken: 'tested-token' }),
  (id: string) => ({ sessionId: id, connected: false, candidateToken: 'tested-token' }),
  (id: string) => ({ sessionId: id, connected: true }),
  (id: string) => ({ sessionId: id, connected: true, candidateToken: '' }),
  (id: string) => ({ sessionId: id, connected: true, candidateToken: 'x'.repeat(129) }),
  (id: string) => ({ sessionId: id, connected: true, candidateToken: '\nSYNTHETIC_PRIVATE' }),
  (id: string) => Object.create({ sessionId: id, connected: true, candidateToken: 'tested-token' }),
])('malformed candidate response cannot initiate storage or reveal payload values %#', async response => {
  const s = setup();
  const run = s.controller.start(config, readiness, candidate);
  s.tests[0].resolve(response(s.id()));
  await run;
  expect(s.controller.state).toBe('error');
  expect(s.bridge.commitTestedKey).not.toHaveBeenCalled();
  expect(s.bridge.cancel).toHaveBeenCalledOnce();
  expect(s.controller.message).not.toContain('SYNTHETIC_PRIVATE');
});

it.each([
  () => null,
  () => [],
  (ack: Record<string, unknown>) => ({ ...ack, supported: false }),
  (ack: Record<string, unknown>) => ({ ...ack, hasKey: false }),
  (ack: Record<string, unknown>) => ({ ...ack, credentialRevision: 'voice-before' }),
  (ack: Record<string, unknown>) => ({ ...ack, credentialRevision: '' }),
  (ack: Record<string, unknown>) => ({ ...ack, mainCredentialRevision: 'main-changed' }),
  (ack: Record<string, unknown>) => ({ ...ack, hasMainKey: false }),
  (ack: Record<string, unknown>) => ({ ...ack, keySource: 'shared' }),
  (ack: Record<string, unknown>) => ({ ...ack, activeConfig: undefined }),
  (ack: Record<string, unknown>) => ({ ...ack, activeConfig: { ...config, workspace: 'other' } }),
  (ack: Record<string, unknown>) => ({ ...ack, activeConfig: { ...config, region: 'singapore' } }),
  (ack: Record<string, unknown>) => ({ ...ack, activeConfig: { ...config, model: 'other' } }),
  (ack: Record<string, unknown>) => ({ ...ack, maskedKey: 'SYNTHETIC_PRIVATE_SECRET' }),
  (ack: Record<string, unknown>) => ({ ...ack, maskedKey: 'x'.repeat(512) }),
  (ack: Record<string, unknown>) => Object.create(ack),
])('unverified storage acknowledgement cannot report success %#', async response => {
  const s = setup();
  const run = s.controller.start(config, readiness, candidate);
  await s.connected();
  s.commits[0].resolve(response(s.ack()));
  await run;
  expect(s.controller.state).toBe('error');
  expect(s.committed).not.toHaveBeenCalled();
  expect(s.bridge.cancel).toHaveBeenCalledOnce();
  expect(s.controller.message).not.toContain('SYNTHETIC_PRIVATE');
});

it.each(['test', 'commit'] as const)('timeout covers the complete transaction during %s and ignores late success', async phase => {
  vi.useFakeTimers();
  const s = setup();
  const run = s.controller.start(config, readiness, candidate);
  const id = s.id();
  await vi.advanceTimersByTimeAsync(30_000);
  if (phase === 'commit') await s.connected();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(s.controller.state).toBe('error');
  expect(s.controller.message).toContain('SPEECH_TIMEOUT');
  expect(s.bridge.cancel).toHaveBeenCalledWith({ sessionId: id });
  expect(s.controller.busy).toBe(false);
  if (phase === 'test') await s.connected();
  else s.commits[0].resolve(s.ack());
  await run;
  expect(s.controller.state).toBe('error');
  expect(s.committed).not.toHaveBeenCalled();
  expect(s.bridge.commitTestedKey).toHaveBeenCalledTimes(phase === 'commit' ? 1 : 0);
});

it.each(['test', 'commit'] as const)('disposing during %s cancels without repaint or implicit restart', async phase => {
  const s = setup();
  const run = s.controller.start(config, readiness, candidate);
  if (phase === 'commit') await s.connected();
  s.controller.dispose();
  const changedCount = s.changed.mock.calls.length;
  if (phase === 'test') await s.connected();
  else s.commits[0].resolve(s.ack());
  await run;
  await s.controller.start(config, readiness, candidate);
  expect(s.bridge.testCandidate).toHaveBeenCalledOnce();
  expect(s.bridge.cancel).toHaveBeenCalledOnce();
  expect(s.committed).not.toHaveBeenCalled();
  expect(s.changed).toHaveBeenCalledTimes(changedCount);
});

it('recording and legacy tests remain excluded throughout the storage commit', async () => {
  const s = setup();
  const callbacks = { onState: vi.fn(), onText: vi.fn(), onError: vi.fn() };
  const recording = new BailianVoiceSession(s.bridge, callbacks);
  const legacy = new BailianVoiceConnectionTest(s.bridge, vi.fn());
  const run = s.controller.start(config, readiness, candidate);
  await s.connected();
  await recording.start(config, readiness);
  await legacy.start(config, readiness);
  expect(s.bridge.start).not.toHaveBeenCalled();
  expect(s.bridge.testConnection).not.toHaveBeenCalled();
  expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('SPEECH_BUSY'));
  expect(legacy.message).toContain('SPEECH_BUSY');
  s.commits[0].resolve(s.ack());
  await run;
  vi.mocked(s.bridge.start).mockReturnValue(new Promise(() => {}));
  void recording.start(config, readiness);
  await Promise.resolve();
  await s.controller.start(config, readiness, candidate);
  expect(s.bridge.testCandidate).toHaveBeenCalledOnce();
  expect(s.controller.message).toContain('SPEECH_BUSY');
  recording.dispose();
});

it('configuration and readiness snapshots cannot change between testing and commit', async () => {
  const s = setup();
  const mutableConfig = { ...config };
  const mutableReadiness = { ...readiness };
  const mutableCandidate = { ...candidate };
  const run = s.controller.start(mutableConfig, mutableReadiness, mutableCandidate);
  mutableConfig.workspace = 'other';
  mutableReadiness.credentialRevision = 'voice-other';
  mutableReadiness.mainCredentialRevision = 'main-other';
  mutableCandidate.configurationId = 'config-other';
  await s.connected();
  expect(s.bridge.commitTestedKey).toHaveBeenCalledWith(expect.objectContaining({
    configurationId: 'config-before', expectedCredentialRevision: 'voice-before', expectedMainCredentialRevision: 'main-before',
  }));
  s.commits[0].resolve(s.ack());
  await run;
  expect(s.controller.state).toBe('success');
});

it.each(['test', 'commit'] as const)('native errors in %s stay sanitized and release the operation', async phase => {
  const s = setup();
  const run = s.controller.start(config, readiness, candidate);
  if (phase === 'commit') await s.connected();
  (phase === 'test' ? s.tests[0] : s.commits[0]).reject({
    code: 'SPEECH_KEY_CHANGED', message: 'SYNTHETIC_PRIVATE_SECRET', data: { phase: 'configuring', details: candidate.value },
  });
  await run;
  expect(s.controller.state).toBe('error');
  expect(s.controller.message).toContain('SPEECH_KEY_CHANGED');
  expect(s.controller.message).not.toContain('SYNTHETIC_PRIVATE');
  expect(s.controller.busy).toBe(false);
  expect(s.committed).not.toHaveBeenCalled();
});

it('a reentrant UI invalidation at the testing update does not dispatch credentials', async () => {
  const s = setup();
  s.changed.mockImplementationOnce(() => s.controller.invalidate());
  await s.controller.start(config, readiness, candidate);
  expect(s.bridge.testCandidate).not.toHaveBeenCalled();
  expect(s.controller.state).toBe('idle');
});

it('a commit callback that invalidates configuration cannot repaint stale success', async () => {
  const s = setup();
  s.committed.mockImplementationOnce(() => s.controller.invalidate());
  const run = s.controller.start(config, readiness, candidate);
  await s.connected();
  s.commits[0].resolve(s.ack());
  await run;
  expect(s.controller.state).toBe('idle');
});

it.each(['••••••', 'abcde••••••vwxyz', '  abcde••••••vwxyz  '])('a display mask is never dispatched as a new credential: %s', async value => {
  const s = setup();
  await s.controller.start(config, readiness, { ...candidate, value });
  expect(s.controller.state).toBe('error');
  expect(s.bridge.testCandidate).not.toHaveBeenCalled();
  expect(s.bridge.commitTestedKey).not.toHaveBeenCalled();
});

it.each(['test', 'commit'] as const)('timeout settles start() even when the native %s promise never settles', async phase => {
  vi.useFakeTimers();
  const s = setup();
  const settled = vi.fn();
  void s.controller.start(config, readiness, candidate).then(settled);
  if (phase === 'commit') await s.connected();
  await vi.advanceTimersByTimeAsync(35_000);
  expect(settled).toHaveBeenCalledOnce();
  expect(s.controller.busy).toBe(false);
  expect(s.controller.message).toContain('SPEECH_TIMEOUT');
});

it.each(['invalidate', 'dispose'] as const)('%s settles start() without waiting for a native response', async action => {
  const s = setup();
  const settled = vi.fn();
  const run = s.controller.start(config, readiness, candidate).then(settled);
  s.controller[action]();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toHaveBeenCalledOnce();
  await run;
});

it('a separately entered candidate does not require a main key', async () => {
  const s = setup();
  const run = s.controller.start(config, { ...readiness, hasKey: false, hasMainKey: false }, candidate);
  await s.connected();
  s.commits[0].resolve(s.ack({ hasMainKey: false, maskedMainKey: '' }));
  await run;
  expect(s.controller.state).toBe('success');
  expect(s.committed).toHaveBeenCalledWith(expect.objectContaining({ hasMainKey: false, maskedMainKey: '' }));
});

it('sanitized native masks preserve Unicode codepoints while never forwarding invalid main-key summaries', async () => {
  const s = setup();
  const run = s.controller.start(config, readiness, candidate);
  await s.connected();
  const safeMask = '🔑甲乙丙丁••••••戊己庚辛🔐';
  s.commits[0].resolve(s.ack({ maskedKey: safeMask, maskedMainKey: 'SYNTHETIC_PRIVATE_SECRET' }));
  await run;
  expect(s.controller.state).toBe('success');
  expect(s.committed).toHaveBeenCalledWith(expect.objectContaining({ maskedKey: safeMask }));
  expect(s.committed.mock.calls[0][0]).not.toHaveProperty('maskedMainKey');
});
