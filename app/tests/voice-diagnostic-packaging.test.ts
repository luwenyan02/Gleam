import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

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
  expect(workflow).not.toContain('secrets.');
  expect(workflow).not.toContain('GLEAM_KEYSTORE');
});
