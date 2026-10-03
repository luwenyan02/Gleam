import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReport, evaluateTimezone, TIMEZONES } from './ai-eval-report.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_DIR = resolve(APP_DIR, '..');
const OUTPUT_DIR = join(ROOT_DIR, '.tmp', 'ai-eval');

// No model keys, .env loading, app Vite plugins or inherited NODE_OPTIONS.
export function offlineEnvironment(source, timezone, telemetryDir) {
  const env = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'CI', 'GITHUB_ACTIONS']) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  return { ...env, TZ: timezone, LANG: 'C.UTF-8', NO_COLOR: '1', AI_EVAL_OFFLINE: '1', AI_EVAL_TELEMETRY_DIR: telemetryDir };
}

export function executeTimezone({ appDir, runDir, configPath, expectedFiles, timezone, spawn = spawnSync, env = process.env }) {
  const startedAt = new Date().toISOString();
  const outputDir = join(runDir, timezone.replaceAll('/', '_'));
  const telemetryDir = join(outputDir, 'telemetry');
  // Refuse an existing child directory so a stale successful report cannot be reused.
  mkdirSync(outputDir);
  mkdirSync(telemetryDir);
  const reportPath = join(outputDir, 'vitest.json');
  let execution;
  try {
    const child = spawn(process.execPath, [
      join(appDir, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', configPath,
      '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`,
    ], {
      cwd: appDir, env: offlineEnvironment(env, timezone, telemetryDir), encoding: 'utf8',
      timeout: 180_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    });
    writeFileSync(join(outputDir, 'stdout.log'), child.stdout ?? '');
    writeFileSync(join(outputDir, 'stderr.log'), child.stderr ?? '');
    execution = { exitCode: child.status, signal: child.signal ?? null, error: child.error?.message ?? null };
  } catch (error) {
    execution = { exitCode: null, signal: null, error: error.message };
  }
  let reportText;
  let reportError;
  try { reportText = readFileSync(reportPath, 'utf8'); }
  catch (error) { reportError = `Cannot read Vitest report: ${error.message}`; }
  const telemetry = [];
  const telemetryErrors = [];
  for (const file of readdirSync(telemetryDir)) {
    try {
      if (!file.endsWith('.json')) throw new Error(`Unexpected telemetry entry: ${file}`);
      telemetry.push(JSON.parse(readFileSync(join(telemetryDir, file), 'utf8')));
    } catch (error) { telemetryErrors.push(`${file}: ${error.message}`); }
  }
  return evaluateTimezone({
    timezone, startedAt, completedAt: new Date().toISOString(), execution, reportText, reportError,
    telemetry, telemetryErrors, expectedFiles, appDir,
  });
}

export function main() {
  const startedAt = new Date().toISOString();
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const runDir = mkdtempSync(join(OUTPUT_DIR, `${startedAt.replaceAll(':', '-')}-`));
  const errors = [];
  let git = { sha: null, dirty: null };
  try {
    git = {
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim().length > 0,
    };
  } catch (error) { errors.push(`Cannot read Git metadata: ${error.message}`); }
  let expectedFiles = [];
  try {
    expectedFiles = readdirSync(join(APP_DIR, 'tests', 'ai-eval'), { withFileTypes: true })
      .filter(file => file.isFile() && file.name.endsWith('.test.ts'))
      .map(file => join(APP_DIR, 'tests', 'ai-eval', file.name)).sort();
  } catch (error) { errors.push(`Cannot discover eval tests: ${error.message}`); }

  const configPath = join(runDir, 'vitest.config.mjs');
  writeFileSync(configPath, `export default ${JSON.stringify({
    root: APP_DIR,
    test: {
      include: ['tests/ai-eval/*.test.ts'], environment: 'node', isolate: true,
      pool: 'forks', fileParallelism: false, maxWorkers: 1, allowOnly: false,
      passWithNoTests: false, retry: 0, testTimeout: 10_000, hookTimeout: 10_000,
    },
  }, null, 2)};\n`);
  const runs = [];
  for (const timezone of TIMEZONES) {
    console.log(`AI ledger offline eval: ${timezone}`);
    try {
      const run = executeTimezone({ appDir: APP_DIR, runDir, configPath, expectedFiles, timezone });
      runs.push(run);
      console.log(`  ${run.status}: ${run.counts.executed} executed, ${run.counts.passed} passed, ${run.counts.failed} failed, ${run.counts.skipped} skipped`);
      for (const failure of run.failures) console.error(`  ${failure.field}: ${failure.message}`);
    } catch (error) { errors.push(`${timezone}: ${error.stack ?? error.message}`); }
  }
  const report = buildReport({ startedAt, completedAt: new Date().toISOString(), git, runs, errors });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(runDir, 'report.json'), serialized);
  const temporaryReport = join(OUTPUT_DIR, `report.${process.pid}.tmp`);
  writeFileSync(temporaryReport, serialized);
  renameSync(temporaryReport, join(OUTPUT_DIR, 'report.json'));
  console.log(`AI eval ${report.status}: ${join(OUTPUT_DIR, 'report.json')}`);
  process.exitCode = report.status === 'passed' ? 0 : 1;
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); }
  catch (error) {
    console.error(`AI eval runner failed: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}
