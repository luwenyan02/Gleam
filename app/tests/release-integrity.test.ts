import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
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

function decodePng(buffer: Buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const chunks: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      colorType = data[9];
      expect(data[12]).toBe(0);
    } else if (type === 'IDAT') {
      chunks.push(data);
    }
    offset += length + 12;
  }

  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  expect(channels).toBeGreaterThan(0);
  const stride = width * channels;
  const encoded = inflateSync(Buffer.concat(chunks));
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = encoded[sourceOffset++];
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[sourceOffset++];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upperLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
      } else expect(filter).toBe(0);
      pixels[y * stride + x] = (raw + predictor) & 0xff;
    }
  }

  return {
    width,
    height,
    rgb(x: number, y: number) {
      const start = y * stride + x * channels;
      return [pixels[start], pixels[start + 1], pixels[start + 2]];
    },
    alpha(x: number, y: number) {
      return channels === 4 ? pixels[y * stride + x * channels + 3] : 255;
    },
  };
}

describe('Android 启动图标', () => {
  it('透明前景收进安全区，渐变背景铺满普通与圆形入口', () => {
    const resources = [
      '../android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
      '../android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml',
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

    for (const xml of resources) {
      expect(xml).toContain('<background android:drawable="@mipmap/ic_launcher_background" />');
      expect(xml).toContain('<inset');
      expect(xml).toContain('android:drawable="@mipmap/ic_launcher_foreground"');
      expect(xml.match(/android:inset(?:Left|Top|Right|Bottom)="18dp"/g)).toHaveLength(4);
    }
  });

  it('各密度背景图的四条可见边均由 Logo 色彩填满', () => {
    for (const density of ['ldpi', 'mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      const icon = decodePng(
        readFileSync(
          new URL(`../android/app/src/main/res/mipmap-${density}/ic_launcher_background.png`, import.meta.url),
        ),
      );
      const edgePixels = [
        icon.rgb(Math.floor(icon.width / 2), 0),
        icon.rgb(icon.width - 1, Math.floor(icon.height / 2)),
        icon.rgb(Math.floor(icon.width / 2), icon.height - 1),
        icon.rgb(0, Math.floor(icon.height / 2)),
      ];
      for (const [red, green, blue] of edgePixels) {
        expect(red > 240 && green > 240 && blue > 240).toBe(false);
      }
    }
  });

  it('各密度前景的外部背景透明，书本主体保持不透明', () => {
    for (const density of ['ldpi', 'mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
      const foreground = decodePng(
        readFileSync(
          new URL(`../android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, import.meta.url),
        ),
      );
      expect(foreground.alpha(0, 0)).toBeLessThan(8);
      expect(foreground.alpha(foreground.width - 1, 0)).toBeLessThan(8);
      expect(foreground.alpha(0, foreground.height - 1)).toBeLessThan(8);
      expect(foreground.alpha(foreground.width - 1, foreground.height - 1)).toBeLessThan(8);
      expect(foreground.alpha(Math.floor(foreground.width / 2), Math.floor(foreground.height / 2))).toBeGreaterThan(247);
    }
  });
});
