import { resolve } from 'node:path';

export const ORACLE_VERSION = 'synthetic-ledger-v1';
export const TIMEZONES = ['UTC', 'Asia/Shanghai', 'America/New_York'];

const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyCounts = () => ({ total: 0, executed: 0, passed: 0, failed: 0, skipped: 0 });

/** Fail closed: process, reporter, assertions and offline telemetry must all agree. */
export function evaluateTimezone({
  timezone, startedAt, completedAt, execution, reportText, reportError,
  telemetry = [], telemetryErrors = [], expectedFiles = [], appDir,
}) {
  const failures = [];
  const fail = (field, message) => failures.push({ field, message });
  const counts = emptyCounts();
  const suites = [];
  const requestCounts = { mocked: 0, unmocked: 0 };
  const normalize = file => resolve(appDir, file);
  const expected = new Set(expectedFiles.map(normalize));
  if (!expected.size) fail('discovery', 'No tests/ai-eval/*.test.ts files were discovered');
  if (!execution || execution.exitCode !== 0) fail('process.exitCode', `Vitest exited with ${execution?.exitCode ?? 'no exit code'}`);
  if (execution?.signal) fail('process.signal', `Vitest terminated with ${execution.signal}`);
  if (execution?.error) fail('process.error', execution.error);
  if (reportError) fail('report', reportError);

  let report;
  try {
    if (typeof reportText !== 'string') throw new Error('Vitest JSON report is missing');
    report = JSON.parse(reportText);
    if (!object(report) || !Array.isArray(report.testResults)) throw new Error('Vitest JSON report has no testResults array');
  } catch (error) {
    fail('report', error.message);
    report = null;
  }

  const seenFiles = new Set();
  let todoCount = 0;
  let pendingCount = 0;
  if (report) {
    if (report.success !== true) fail('report.success', 'Vitest did not report success');
    if (!report.testResults.length) fail('report.testResults', 'Vitest reported no test files');
    for (const [suiteIndex, result] of report.testResults.entries()) {
      const prefix = `testResults[${suiteIndex}]`;
      if (!object(result) || typeof result.name !== 'string' || !result.name || !Array.isArray(result.assertionResults)) {
        fail(prefix, 'Malformed test-file result');
        continue;
      }
      const file = normalize(result.name);
      if (!expected.has(file)) fail(`${prefix}.name`, `Unexpected test file: ${file}`);
      if (seenFiles.has(file)) fail(`${prefix}.name`, `Duplicate test file: ${file}`);
      seenFiles.add(file);
      if (result.status !== 'passed') fail(`${prefix}.status`, result.message || `Test file status is ${result.status}`);
      if (result.message) fail(`${prefix}.message`, String(result.message));
      if (!result.assertionResults.length) fail(`${prefix}.assertionResults`, 'Test file has no cases');
      const groups = new Map();
      for (const [caseIndex, assertion] of result.assertionResults.entries()) {
        const field = `${prefix}.assertionResults[${caseIndex}]`;
        if (!object(assertion) || typeof assertion.title !== 'string' || !assertion.title
          || typeof assertion.fullName !== 'string' || !assertion.fullName
          || !Array.isArray(assertion.ancestorTitles) || !assertion.ancestorTitles.every(title => typeof title === 'string')
          || !Array.isArray(assertion.failureMessages) || !assertion.failureMessages.every(message => typeof message === 'string')) {
          fail(field, 'Malformed case result');
          continue;
        }
        counts.total += 1;
        const status = assertion.status;
        const validStatus = ['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled'].includes(status);
        if (status === 'passed') counts.passed += 1;
        else if (status === 'failed') counts.failed += 1;
        else {
          counts.skipped += 1;
          if (status === 'todo') todoCount += 1;
          else pendingCount += 1;
        }
        let failure = null;
        if (!validStatus || status !== 'passed' || assertion.failureMessages.length) {
          failure = {
            field: `${assertion.fullName}.${status === 'failed' ? 'assertion' : 'status'}`,
            message: assertion.failureMessages.join('\n') || `Case status is ${String(status)}; every case must execute and pass`,
          };
          fail(field, failure.message);
        }
        const group = assertion.ancestorTitles.join(' > ') || '(ungrouped)';
        if (!groups.has(group)) groups.set(group, { group, cases: [] });
        groups.get(group).cases.push({
          name: assertion.title, fullName: assertion.fullName, status: validStatus ? status : 'invalid',
          durationMs: Number.isFinite(assertion.duration) && assertion.duration >= 0 ? assertion.duration : null,
          failure,
        });
      }
      suites.push({ suite: file, status: result.status, groups: [...groups.values()] });
    }
    counts.executed = counts.passed + counts.failed;
    if (!counts.executed) fail('counts.executed', 'No test cases actually executed');
    for (const [key, actual] of Object.entries({
      numTotalTests: counts.total, numPassedTests: counts.passed, numFailedTests: counts.failed,
      numPendingTests: pendingCount, numTodoTests: todoCount,
    })) {
      if (!integer(report[key]) || report[key] !== actual) fail(`report.${key}`, `Reported ${String(report[key])}; observed ${actual}`);
    }
    for (const key of ['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites']) {
      if (!integer(report[key])) fail(`report.${key}`, 'Missing or invalid suite counter');
    }
    if (report.numTotalTestSuites < seenFiles.size
      || report.numTotalTestSuites !== report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites) {
      fail('report.numTotalTestSuites', 'Suite counters are inconsistent');
    }
    if (report.numFailedTestSuites !== 0 || report.numPendingTestSuites !== 0) fail('report.suites', 'Failed or pending suites were reported');
  }
  for (const file of expected) if (!seenFiles.has(file)) fail('coverage', `Expected test file did not execute: ${file}`);

  for (const error of telemetryErrors) fail('telemetry', error);
  const telemetryFiles = new Set();
  if (!Array.isArray(telemetry)) {
    fail('telemetry', 'Telemetry must be an array');
    telemetry = [];
  }
  for (const record of telemetry) {
    if (!object(record) || typeof record.file !== 'string' || !record.file
      || !integer(record.mockedRequestCount) || !integer(record.unmockedRequestCount)) {
      fail('telemetry', 'Malformed offline request telemetry');
      continue;
    }
    const file = normalize(record.file);
    if (!expected.has(file) || !seenFiles.has(file)) fail('telemetry.file', `Telemetry does not match an executed test file: ${file}`);
    if (telemetryFiles.has(file)) fail('telemetry.file', `Duplicate telemetry for ${file}`);
    telemetryFiles.add(file);
    requestCounts.mocked += record.mockedRequestCount;
    requestCounts.unmocked += record.unmockedRequestCount;
    if (record.unmockedRequestCount > 0) fail('telemetry.unmockedRequestCount', `${file}: ${record.unmockedRequestCount} unexpected outbound request(s)`);
    const suite = suites.find(item => item.suite === file);
    if (suite) suite.requestCounts = { mocked: record.mockedRequestCount, unmocked: record.unmockedRequestCount };
    if (record.cases !== undefined) {
      if (!Array.isArray(record.cases)) {
        fail('telemetry.cases', `Malformed per-case telemetry for ${file}`);
        continue;
      }
      const remaining = suite?.groups.flatMap(group => group.cases.map(test => ({
        test, path: group.group === '(ungrouped)' ? test.name : `${group.group} > ${test.name}`,
      }))) ?? [];
      const totals = { mocked: 0, unmocked: 0 };
      for (const item of record.cases) {
        if (!object(item) || typeof item.fullName !== 'string' || !item.fullName
          || !integer(item.mockedRequestCount) || !integer(item.unmockedRequestCount)) {
          fail('telemetry.cases', `Malformed per-case request counters for ${file}`);
          continue;
        }
        const index = remaining.findIndex(({ test, path }) => item.fullName === path || item.fullName === test.fullName);
        if (index === -1) fail('telemetry.cases', `Unknown or duplicate case telemetry: ${item.fullName}`);
        else remaining.splice(index, 1)[0].test.requestCounts = { mocked: item.mockedRequestCount, unmocked: item.unmockedRequestCount };
        totals.mocked += item.mockedRequestCount;
        totals.unmocked += item.unmockedRequestCount;
      }
      if (remaining.length) fail('telemetry.cases', `Missing request counters for ${remaining.length} case(s) in ${file}`);
      if (totals.mocked !== record.mockedRequestCount || totals.unmocked !== record.unmockedRequestCount) {
        fail('telemetry.cases', `Per-case request counts disagree with suite totals for ${file}`);
      }
    }
  }
  for (const file of expected) if (!telemetryFiles.has(file)) fail('telemetry', `Missing offline request telemetry for ${file}`);

  return {
    timezone, startedAt, completedAt, status: failures.length ? 'failed' : 'passed',
    process: execution, counts, requestCounts, suites, failures,
  };
}

export function buildReport({ startedAt, completedAt, git, runs, errors = [] }) {
  const failures = errors.map(message => ({ field: 'runner', message }));
  if (!git || !/^[a-f\d]{40,64}$/i.test(git.sha ?? '') || typeof git.dirty !== 'boolean') {
    failures.push({ field: 'git', message: 'Git SHA and dirty status could not be established' });
  }
  if (runs.length !== TIMEZONES.length || TIMEZONES.some(timezone => runs.filter(run => run.timezone === timezone).length !== 1)) {
    failures.push({ field: 'timezones', message: 'Exactly one run is required for every configured timezone' });
  }
  const inventory = run => JSON.stringify(run.suites.flatMap(suite => suite.groups.flatMap(group =>
    group.cases.map(test => [suite.suite, test.fullName]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  if (runs.length && runs.some(run => inventory(run) !== inventory(runs[0]))) {
    failures.push({ field: 'timezones.cases', message: 'The executed case inventory differs between timezones' });
  }
  const counts = emptyCounts();
  const requestCounts = { mocked: 0, unmocked: 0 };
  for (const run of runs) {
    for (const key of Object.keys(counts)) counts[key] += run.counts[key];
    requestCounts.mocked += run.requestCounts.mocked;
    requestCounts.unmocked += run.requestCounts.unmocked;
  }
  return {
    schemaVersion: 1, oracleVersion: ORACLE_VERSION, startedAt, completedAt, git,
    offline: true, actualModel: 'untested', toolSelection: 'N/A',
    status: failures.length || runs.some(run => run.status !== 'passed') ? 'failed' : 'passed',
    counts, requestCounts, runs, failures,
  };
}
