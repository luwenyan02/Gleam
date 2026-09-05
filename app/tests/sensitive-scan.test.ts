import { describe, expect, it } from 'vitest';
import { findSensitiveFindings } from '../scripts/sensitive-scan.mjs';

describe('sensitive repository scan', () => {
  it('flags private paths that must never be committed', () => {
    expect(findSensitiveFindings('uploads/real-account.jpg', '')).toContain('禁止提交的路径');
    expect(findSensitiveFindings('android/release.keystore', '')).toContain('禁止提交的路径');
  });

  it('flags hard-coded signing passwords and internal registries', () => {
    const passwordLiteral = `store${'Password'} 'not-a-placeholder'`;
    const internalRegistry = `https://registry.${'anpm'}.alibaba-inc.com/pkg`;
    expect(findSensitiveFindings('build.gradle', passwordLiteral)).toContain('疑似硬编码签名口令');
    expect(findSensitiveFindings('package-lock.json', internalRegistry)).toContain('内部依赖源');
  });

  it('allows signing property references and documentation placeholders', () => {
    expect(findSensitiveFindings('build.gradle', 'storePassword signingStorePassword')).toEqual([]);
    expect(findSensitiveFindings('docs/release.md', 'storePassword=<由密码管理器生成>')).toEqual([]);
  });
});
