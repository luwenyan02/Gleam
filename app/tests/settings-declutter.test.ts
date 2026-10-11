import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const settings = readFileSync('src/features/settings/settings.ts', 'utf8');
const voiceSettings = readFileSync('src/features/settings/bailianVoiceSettings.ts', 'utf8');

it('settings routine surface removes tutorial paragraphs instead of merely hiding their CSS', () => {
  for (const sentence of ['跟随系统时随设备深浅色自动切换', '开＝到账记一笔', '预设核对于', '识别请求直连你填写的接口', '拾光是一款极简暖调记账应用', '删除的账单先进回收站']) expect(settings).not.toContain(sentence);
  expect(voiceSettings).not.toContain('使用与隐私说明');
  expect(settings).toContain('data-act="settings-manual"');
});

it('operational labels, values and security warnings remain available', () => {
  for (const required of ['静默入账置信度阈值', 'API 地址', '回收站保留', '天后自动清除', '忘记 PIN 将无法解锁', 'ai-model-capability', '每月起始日']) expect(settings).toContain(required);
  for (const required of ['独立语音 API Key', '服务地域', '业务空间 ID', 'data-voice-key-status', 'voiceConnectionTestHtml']) expect(voiceSettings).toContain(required);
});
