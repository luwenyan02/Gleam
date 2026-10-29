import { expect, it } from 'vitest';
import { BAILIAN_VOICE_MODEL, bailianVoiceDestination, validateBailianVoiceConfig } from '../src/core/bailianVoiceConfig';

const config = { region: 'beijing' as const, workspace: '', model: BAILIAN_VOICE_MODEL };

it('业务空间留空时按地域选择官方共享地址', () => {
  expect(validateBailianVoiceConfig(config)).toEqual(config);
  expect(bailianVoiceDestination(config)).toBe('dashscope.aliyuncs.com');
  expect(bailianVoiceDestination({ ...config, region: 'singapore' })).toBe('dashscope-intl.aliyuncs.com');
});

it('旧业务空间配置保持原有地址，不迁移到共享地址', () => {
  expect(bailianVoiceDestination({ ...config, workspace: 'existing-space' })).toBe('existing-space.cn-beijing.maas.aliyuncs.com');
  expect(bailianVoiceDestination({ ...config, region: 'singapore', workspace: 'existing-space' })).toBe('existing-space.ap-southeast-1.maas.aliyuncs.com');
});

it.each([null, undefined, 0, 'evil.example', 'user@host', 'host/path', '-space', 'space-', 'x'.repeat(64)])('空字符串以外的非法空间 %s 仍拒绝', workspace => {
  expect(() => validateBailianVoiceConfig({ ...config, workspace: workspace as string })).toThrow();
});
