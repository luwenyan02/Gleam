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

/** 2026-10-03 用户明确选择复用的原本地证书；这里只存公开 SHA-256。 */
export const RELEASE_CERTIFICATE_SHA256 = 'f979d49ce586a7438bcaf44bcec4b4edaa9e80cba170a07f8f8895b757380012';

/** apksigner 已先验证 APK 签名有效；再要求唯一实际签名者与用户所选证书一致。 */
export function verifyReleaseCertificate(signature) {
  const certificates = typeof signature === 'string'
    ? [...signature.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9]{64})\s*$/gim)].map(match => match[1].toLowerCase())
    : [];
  if (certificates.length !== 1 || certificates[0] !== RELEASE_CERTIFICATE_SHA256) {
    throw new Error('APK 不是当前授权发布证书签名，禁止发布');
  }
}
