import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
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

describe('Android 启动图标安全区', () => {
  it('完整 Logo 收进自适应图标 66dp 安全区，普通与圆形入口保持一致', () => {
    const resources = [
      '../android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
      '../android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml',
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
    const background = readFileSync(
      new URL('../android/app/src/main/res/values/ic_launcher_background.xml', import.meta.url),
      'utf8',
    );

    for (const xml of resources) {
      expect(xml).toContain('<inset');
      expect(xml).toContain('android:drawable="@mipmap/ic_launcher_foreground"');
      expect(xml.match(/android:inset(?:Left|Top|Right|Bottom)="21dp"/g)).toHaveLength(4);
    }
    expect(background).toContain('<color name="ic_launcher_background">#FFFFFF</color>');
  });
});
