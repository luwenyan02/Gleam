import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const usesWorkflowSecrets = (workflow: string) => {
  let start = workflow.indexOf('${{');
  while (start >= 0) {
    let quoted = false, expression = '', end = start + 3;
    // GitHub expressions use single-quoted strings; doubled quotes escape a quote.
    for (; end < workflow.length; end++) {
      if (workflow[end] === "'") {
        if (quoted && workflow[end + 1] === "'") { end++; continue; }
        quoted = !quoted;
      } else if (!quoted && workflow.startsWith('}}', end)) break;
      else if (!quoted) expression += workflow[end];
    }
    if (/\bsecrets\b/i.test(expression)) return true;
    start = workflow.indexOf('${{', end + 2);
  }
  return false;
};

it('unsigned test flag is exact opt-in and cannot consume an existing signing configuration', () => {
  const gradle = readFileSync('android/app/build.gradle', 'utf8');
  expect(gradle).toContain("def unsignedTestApk = project.findProperty('gleamUnsignedTestApk') == 'true'");
  expect(gradle).toContain('if (hasReleaseSigning && !unsignedTestApk)');
  expect(gradle).toContain('if (requestsRelease && !hasReleaseSigning && !unsignedTestApk)');
  expect(gradle).not.toContain("hasProperty('gleamUnsignedTestApk')");
});
it('CI rejects absent or multiple APKs before archiving web resources and never receives signing secrets', () => {
  const workflow = readFileSync('../.github/workflows/ci.yml', 'utf8');
  expect(workflow).toContain('test "${#apks[@]}" -eq 1');
  expect(workflow).toContain('test -s "${apks[0]}"');
  expect(workflow.indexOf('Require exactly one unsigned diagnostic APK')).toBeLessThan(workflow.indexOf('Preserve unsigned diagnostic candidate'));
  expect(workflow).toContain('retention-days: 3');
  expect(usesWorkflowSecrets(workflow)).toBe(false);
  expect(workflow).not.toContain('GLEAM_KEYSTORE');
});

it('distinguishes scanner filenames from every GitHub secrets expression form', () => {
  expect(usesWorkflowSecrets('run: python3 scripts/check-history-secrets.py')).toBe(false);
  expect(usesWorkflowSecrets("${{ 'secrets.SIGNING_PASSWORD }}' }}")).toBe(false);
  for (const expression of ['${{ secrets.SIGNING_PASSWORD }}', "${{ secrets['SIGNING_PASSWORD'] }}", '${{ toJSON(secrets) }}', '${{ SeCrEtS.SIGNING_PASSWORD }}', "${{ format('}} {0}', secrets.SIGNING_PASSWORD) }}", "${{ format('it''s }} {0}', secrets['SIGNING_PASSWORD']) }}"]) {
    expect(usesWorkflowSecrets(expression)).toBe(true);
  }
});
