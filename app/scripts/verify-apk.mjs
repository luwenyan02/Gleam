import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { verifyReleaseCertificate, verifyWebAssets } from './release-integrity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const apk = resolve(process.argv[2] || join(root, 'android/app/build/outputs/apk/release/app-release.apk'));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error('请设置 ANDROID_HOME 指向 Android SDK');
const buildTools = readdirSync(join(sdk, 'build-tools')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
const bin = join(sdk, 'build-tools', buildTools);
const files = new Map();
function collect(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) collect(join(dir, entry.name), `${name}/`);
    else files.set(name, readFileSync(join(dir, entry.name)));
  }
}
collect(join(root, 'dist'));
const count = await verifyWebAssets(await JSZip.loadAsync(readFileSync(apk)), files, version);
const manifest = execFileSync(join(bin, 'aapt'), ['dump', 'badging', apk], { encoding: 'utf8' });
const [major, minor, patch] = version.split('.').map(Number);
if (!manifest.includes(`versionName='${version}'`) || !manifest.includes(`versionCode='${major * 10000 + minor * 100 + patch}'`)) {
  throw new Error('Android 与源码版本不一致');
}
const signature = execFileSync(join(bin, 'apksigner'), ['verify', '--print-certs', apk], { encoding: 'utf8' });
verifyReleaseCertificate(signature);
console.log(`通过：Android / 网页 v${version}，${count} 个网页文件逐字节一致，当前发布证书签名有效。`);
