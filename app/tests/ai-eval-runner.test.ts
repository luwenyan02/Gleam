import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, evaluateTimezone, TIMEZONES } from '../scripts/ai-eval-report.mjs';
import { executeTimezone, offlineEnvironment } from '../scripts/run-ai-eval.mjs';

const appDir = '/synthetic/app';
const testFile = `${appDir}/tests/ai-eval/accounting.test.ts`;
const timestamp = '2026-01-01T00:00:00.000Z';
const git = { sha: 'a'.repeat(40), dirty: false };

function fixture() {
  return {
    numTotalTestSuites: 2, numPassedTestSuites: 2, numFailedTestSuites: 0, numPendingTestSuites: 0,
    numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    success: true,
    testResults: [{
      name: testFile, status: 'passed', message: '',
      assertionResults: [{ ancestorTitles: ['accounting'], title: 'integer cents', fullName: 'accounting integer cents', status: 'passed', duration: 2, failureMessages: [] }],
    }],
  };
}

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateTimezone({
    timezone: 'UTC', startedAt: timestamp, completedAt: timestamp, appDir, expectedFiles: [testFile],
    execution: { exitCode: 0, signal: null, error: null }, reportText: JSON.stringify(fixture()),
    telemetry: [{ file: testFile, mockedRequestCount: 2, unmockedRequestCount: 0 }],
    ...overrides,
  });
}

describe('offline AI eval report is fail-closed', () => {
  it('derives actual executed counts, groups and mocked request counts', () => {
    const run = evaluate();
    expect(run.status).toBe('passed');
    expect(run.counts).toEqual({ total: 1, executed: 1, passed: 1, failed: 0, skipped: 0 });
    expect(run.requestCounts).toEqual({ mocked: 2, unmocked: 0 });
    expect(run.suites[0].groups[0]).toMatchObject({ group: 'accounting', cases: [{ name: 'integer cents', failure: null }] });
  });

  it.each([
    ['missing report', { reportText: undefined }],
    ['malformed JSON', { reportText: '{' }],
    ['malformed report shape', { reportText: 'null' }],
    ['empty report', { reportText: JSON.stringify({ ...fixture(), testResults: [], numTotalTests: 0, numPassedTests: 0 }) }],
    ['missing discovered tests', { expectedFiles: [] }],
    ['nonzero child exit', { execution: { exitCode: 1 } }],
    ['child spawn error', { execution: { exitCode: null, error: 'spawn failed' } }],
    ['child signal', { execution: { exitCode: 0, signal: 'SIGTERM' } }],
    ['missing request telemetry', { telemetry: [] }],
    ['malformed telemetry', { telemetry: [{ file: testFile, mockedRequestCount: -1, unmockedRequestCount: 0 }] }],
    ['malformed telemetry JSON', { telemetryErrors: ['Unexpected token'] }],
    ['unexpected outbound request', { telemetry: [{ file: testFile, mockedRequestCount: 2, unmockedRequestCount: 1 }] }],
    ['missing expected suite', { expectedFiles: [testFile, `${appDir}/tests/ai-eval/privacy.test.ts`] }],
  ])('cannot turn %s green', (_name, overrides) => {
    const run = evaluate(overrides);
    expect(run.status).toBe('failed');
    expect(run.failures.length).toBeGreaterThan(0);
  });

  it.each(['skipped', 'pending', 'todo', 'failed', 'invented'])('rejects a %s case even if Vitest claims success', status => {
    const report = fixture();
    report.testResults[0].assertionResults[0].status = status;
    const run = evaluate({ reportText: JSON.stringify(report) });
    expect(run.status).toBe('failed');
    expect(run.suites[0].groups[0].cases[0].failure).toMatchObject({ field: expect.any(String), message: expect.any(String) });
  });

  it('rejects malformed cases, lying counts, failed hooks and duplicate telemetry', () => {
    const malformed = fixture();
    malformed.testResults[0].assertionResults = [null as never];
    expect(evaluate({ reportText: JSON.stringify(malformed) }).status).toBe('failed');
    expect(evaluate({ reportText: JSON.stringify({ ...fixture(), numTotalTests: 900 }) }).status).toBe('failed');
    const hookFailure = fixture();
    hookFailure.testResults[0].status = 'failed';
    hookFailure.testResults[0].message = 'afterAll failed';
    expect(evaluate({ reportText: JSON.stringify(hookFailure) }).status).toBe('failed');
    const record = { file: testFile, mockedRequestCount: 0, unmockedRequestCount: 0 };
    expect(evaluate({ telemetry: [record, record] }).status).toBe('failed');
  });

  it('matches optional case telemetry and rejects missing, duplicate or inconsistent counters', () => {
    const item = { fullName: 'accounting > integer cents', mockedRequestCount: 2, unmockedRequestCount: 0 };
    const record = { file: testFile, mockedRequestCount: 2, unmockedRequestCount: 0, cases: [item] };
    const run = evaluate({ telemetry: [record] });
    expect(run.status).toBe('passed');
    expect(run.suites[0].groups[0].cases[0].requestCounts).toEqual({ mocked: 2, unmocked: 0 });
    expect(evaluate({ telemetry: [{ ...record, cases: [] }] }).status).toBe('failed');
    expect(evaluate({ telemetry: [{ ...record, cases: [item, item] }] }).status).toBe('failed');
    expect(evaluate({ telemetry: [{ ...record, mockedRequestCount: 3 }] }).status).toBe('failed');
  });

  it('requires the full timezone matrix and valid Git identity without claiming model evaluation', () => {
    const runs = TIMEZONES.map(timezone => evaluate({ timezone }));
    const report = buildReport({ startedAt: timestamp, completedAt: timestamp, git, runs });
    expect(report).toMatchObject({ status: 'passed', oracleVersion: 'synthetic-ledger-v2', offline: true, actualModel: 'untested', toolSelection: 'N/A', counts: { executed: 3 } });
    expect(buildReport({ startedAt: timestamp, completedAt: timestamp, git, runs: runs.slice(1) }).status).toBe('failed');
    expect(buildReport({ startedAt: timestamp, completedAt: timestamp, git: { sha: null, dirty: null }, runs }).status).toBe('failed');
    runs[2].suites[0].groups[0].cases[0].fullName = 'timezone-dependent replacement case';
    expect(buildReport({ startedAt: timestamp, completedAt: timestamp, git, runs }).status).toBe('failed');
  });

  it('does not pass model credentials or ambient Node injection to children', () => {
    const env = offlineEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'synthetic-placeholder', DASHSCOPE_API_KEY: 'synthetic-placeholder', NODE_OPTIONS: '--require injected.js' }, 'Asia/Shanghai', '/tmp/telemetry');
    expect(env).toMatchObject({ PATH: '/bin', TZ: 'Asia/Shanghai', AI_EVAL_OFFLINE: '1' });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('DASHSCOPE_API_KEY');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
  });
});

describe('offline AI eval child execution', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it.each(TIMEZONES)('starts a separate process with TZ=%s and validates its real output', timezone => {
    const runDir = mkdtempSync(join(tmpdir(), 'gleam-ai-eval-runner-'));
    dirs.push(runDir);
    let launches = 0;
    const run = executeTimezone({
      appDir, runDir, configPath: '/synthetic/vitest.config.mjs', expectedFiles: [testFile], timezone,
      spawn: (command: string, args: string[], options: { env: Record<string, string> }) => {
        launches += 1;
        expect(command).toBe(process.execPath);
        expect(args[0]).toBe(`${appDir}/node_modules/vitest/vitest.mjs`);
        expect(options.env.TZ).toBe(timezone);
        const reportPath = args.find(arg => arg.startsWith('--outputFile.json='))!.slice('--outputFile.json='.length);
        writeFileSync(reportPath, JSON.stringify(fixture()));
        writeFileSync(join(options.env.AI_EVAL_TELEMETRY_DIR, 'accounting.json'), JSON.stringify({ file: testFile, mockedRequestCount: 0, unmockedRequestCount: 0 }));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(launches).toBe(1);
    expect(run.status).toBe('passed');
  });

  it('fails if a nominally successful child leaves no report', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'gleam-ai-eval-runner-'));
    dirs.push(runDir);
    const run = executeTimezone({ appDir, runDir, configPath: '/unused', expectedFiles: [testFile], timezone: 'UTC', spawn: () => ({ status: 0 }) });
    expect(run.status).toBe('failed');
    expect(run.counts.executed).toBe(0);
    expect(run.failures.some(failure => failure.field === 'report')).toBe(true);
  });

  it('refuses to reuse a prior timezone directory that could contain a stale passing report', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'gleam-ai-eval-runner-'));
    dirs.push(runDir);
    const options = { appDir, runDir, configPath: '/unused', expectedFiles: [testFile], timezone: 'UTC', spawn: () => ({ status: 0 }) };
    executeTimezone(options);
    expect(() => executeTimezone(options)).toThrow();
  });
});
