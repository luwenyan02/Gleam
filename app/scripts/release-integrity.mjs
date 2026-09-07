import { createHash } from 'node:crypto';

const hash = data => createHash('sha256').update(data).digest('hex');

/** Compare actual APK bytes with the freshly built web directory, not filenames alone. */
export async function verifyWebAssets(zip, files, version) {
  const info = files.get('build-info.json');
  if (!info || JSON.parse(info.toString()).version !== version) throw new Error('网页构建版本不一致，请重新 build');
  for (const [name, content] of files) {
    const entry = zip.file(`assets/public/${name}`);
    if (!entry) throw new Error(`APK 缺少网页资源：${name}`);
    if (hash(await entry.async('nodebuffer')) !== hash(content)) throw new Error(`APK 网页资源不一致：${name}`);
  }
  return files.size;
}
