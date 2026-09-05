const PRIVATE_PATHS = [
  /^(?:uploads|release|\.tmp|\.selftest|outputs)\//,
  /(?:^|\/)wacai\.xls$/i,
  /(?:^|\/)local\.properties$/i,
  /(?:^|\/)\.env(?:\..+)?$/i,
  /\.(?:keystore|jks|p12|pem|apk|aab)$/i,
];

const CONTENT_RULES = [
  {
    label: '内部依赖源',
    pattern: /registry\.anpm\.alibaba-inc\.com/i,
  },
  {
    label: '疑似硬编码签名口令',
    pattern: /(?:storePassword|keyPassword)\s+['"](?!(?:<|\$\{|CHANGE_ME))[^"]+['"]/i,
  },
  {
    label: '疑似私钥或 API 密钥',
    pattern: /(?:-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/,
  },
];

export function findSensitiveFindings(filePath, content) {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const findings = [];
  if (PRIVATE_PATHS.some((pattern) => pattern.test(normalized)) && normalized !== '.env.example') {
    findings.push('禁止提交的路径');
  }
  for (const rule of CONTENT_RULES) {
    if (rule.pattern.test(content)) findings.push(rule.label);
  }
  return [...new Set(findings)];
}
