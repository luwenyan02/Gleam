import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { findSensitiveFindings } from './sensitive-scan.mjs';

const root = new URL('../..', import.meta.url);
const output = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' },
);

const findings = [];
for (const file of output.split('\0').filter(Boolean)) {
  const url = new URL(file, root);
  let content = '';
  try {
    if (statSync(url).size <= 2 * 1024 * 1024) {
      const buffer = readFileSync(url);
      if (!buffer.includes(0)) content = buffer.toString('utf8');
    }
  } catch {
    continue;
  }
  for (const label of findSensitiveFindings(file, content)) findings.push(`${file}: ${label}`);
}

if (findings.length) {
  console.error('敏感信息检查未通过：');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`敏感信息检查通过（${output.split('\0').filter(Boolean).length} 个文件）`);
