import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const sheet = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('../src/features/shell/sheet', () => ({ openSheet: sheet.open, closeSheet: sheet.close }));
import { openSettingsManual, settingsManualHtml } from '../src/features/settings/settingsManual';

it('keeps recipients, costs, limitations and diagnostic scope in the local manual', () => {
  const html = settingsManualHtml();
  for (const text of ['阿里云百炼', '可能产生服务商费用', '设置中的文字 AI 接口', '候选分类和账户名称', '不附带声音、旧账单、余额', '不申请麦克风、不录音、不发送音频', '连接通过不代表录音和实际转写已测试', '关闭页面后不会在系统通知栏准时推送', '忘记 PIN 将无法解锁']) expect(html).toContain(text);
  expect(html).not.toMatch(/<(?:iframe|script)|https?:\/\//);
});
it('opens only a local sheet with an accessible close control', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  try {
    openSettingsManual();
    const options = sheet.open.mock.calls.at(-1)![0];
    expect(options.ariaLabel).toBe('拾光使用手册');
    const addEventListener = vi.fn();
    const el = { innerHTML: '', querySelector: vi.fn(() => ({ addEventListener })), querySelectorAll: vi.fn(() => []) };
    options.render(el);
    expect(el.innerHTML).toContain('关闭使用手册');
    expect(addEventListener).toHaveBeenCalledWith('click', sheet.close);
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it('explains draft replacement and preserved fields, with inbox approval still required', () => {
  const html = settingsManualHtml();
  expect(html).toContain('替换当前草稿的类型、金额、分类、账户、时间和备注');
  expect(html).toContain('标签和凭证保持原选择，确认保存才入账');
  expect(html).toContain('「加入收件箱待确认」只保存到本机待确认队列，可修改后再确认入账');
});

it('uses five bundled real screenshots with semantic steps and explicit zoom controls', () => {
  const html = settingsManualHtml();
  expect(html.match(/<img /g)).toHaveLength(5);
  expect(html.match(/data-manual-zoom=/g)).toHaveLength(5);
  expect(html.match(/class="manual-callout"/g)).toHaveLength(6);
  expect(html).toContain('示例截图使用虚构数据');
  expect(html).toContain('通过后才保存');
  expect(html).toContain('同一按钮取消，录音仍需实际测试');
  expect(html).not.toContain('再点「开始测试」');
  expect(html).not.toContain('复制诊断结果');
  expect(html).toContain('width="390" height="844"');
  expect(html).toContain('aria-expanded="false"');
});

it('preserves the source screenshot bytes and keeps the bundled guide lightweight', () => {
  const source = JSON.parse(readFileSync('public/manual/source.json', 'utf8'));
  expect(source.synthetic).toBe(true); expect(source.imagesUnmodified).toBe(true);
  let bytes = 0;
  for (const [name, hash] of Object.entries(source.sha256)) {
    const image = readFileSync(`public/manual/${name}`); bytes += image.length;
    expect(createHash('sha256').update(image).digest('hex')).toBe(hash);
  }
  expect(Object.keys(source.sha256)).toHaveLength(5);
  expect(bytes).toBeLessThan(300_000);
});
