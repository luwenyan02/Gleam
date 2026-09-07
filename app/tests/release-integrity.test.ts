import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { verifyWebAssets } from '../scripts/release-integrity.mjs';

const files = new Map([
  ['build-info.json', Buffer.from(JSON.stringify({ version: '1.3.1' }))],
  ['assets/app.js', Buffer.from('current app')],
]);

function archive() {
  const zip = new JSZip();
  for (const [name, content] of files) zip.file(`assets/public/${name}`, content);
  return zip;
}

describe('APK 内嵌网页一致性', () => {
  it('接受完全相同的当前资源', async () => {
    await expect(verifyWebAssets(archive(), files, '1.3.1')).resolves.toBe(2);
  });
  it('拒绝包内旧 JS、遗漏文件和旧版本声明', async () => {
    const stale = archive().file('assets/public/assets/app.js', 'old app');
    await expect(verifyWebAssets(stale, files, '1.3.1')).rejects.toThrow('资源不一致');
    await expect(verifyWebAssets(archive().remove('assets/public/assets/app.js'), files, '1.3.1')).rejects.toThrow('缺少');
    await expect(verifyWebAssets(archive(), files, '1.4.0')).rejects.toThrow('版本');
  });
});
