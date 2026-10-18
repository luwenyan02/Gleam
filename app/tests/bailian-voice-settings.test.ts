import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ configuration: vi.fn(), invalidate: vi.fn(), sync: vi.fn(), pick: vi.fn(), setSetting: vi.fn() }));
vi.mock('../src/core/nativeSpeech', () => ({ nativeSpeech: { configuration: mocks.configuration } }));
vi.mock('../src/core/repo/settingsRepo', () => ({ getSetting: vi.fn(async key => key.endsWith('region') ? 'beijing' : 'legacy-space'), setSetting: mocks.setSetting }));
vi.mock('../src/shared/pickList', () => ({ openPickList: mocks.pick }));
vi.mock('../src/features/settings/bailianVoiceTestSettings', () => ({ handleVoiceConnectionTestClick: () => false, invalidateVoiceConnectionTest: mocks.invalidate, syncVoiceConnectionTest: mocks.sync, voiceConnectionTestHtml: () => '<button data-voice-test>测试语音连接</button>' }));
import { bailianVoiceSettingsHtml, handleVoiceSettingsChange, handleVoiceSettingsClick } from '../src/features/settings/bailianVoiceSettings';
const ready = { supported: true, hasKey: true, credentialRevision: 'voice-revision', keySource: 'separate', maskedKey: 'abcde••••••vwxyz', maskedMainKey: 'main1••••••main2', hasMainKey: true };
beforeEach(() => { vi.clearAllMocks(); mocks.configuration.mockResolvedValue(ready); });
it('浏览器仅展示 Android 可用提示，配置保留在默认收起的详情中', async () => {
 mocks.configuration.mockResolvedValue({supported:false,hasKey:false,credentialRevision:''});
 const html = await bailianVoiceSettingsHtml();
 expect(html).toContain('仅 Android 可用');
 expect(html).toMatch(/<details class="settings-details voice-web-details"[^>]*>/);
 expect(html).not.toMatch(/<details[^>]*\bopen\b/);
 expect(html.indexOf('<summary>查看语音配置</summary>')).toBeLessThan(html.indexOf('id="voice-bailian-region"'));
 expect(html).toContain('id="voice-bailian-key"');
 expect(html).toMatch(/id="voice-bailian-key"[^>]*disabled/);
});
it('Android 保持完整语音配置，不在详情中隐藏连接测试', async () => {
 const html = await bailianVoiceSettingsHtml();
 expect(html).not.toContain('<details');
 expect(html).toContain('id="voice-bailian-region"');
 expect(html).toContain('data-voice-test');
});
it('existing independent key retains its source and is displayed only as an empty-input mask', async () => {
 const html = await bailianVoiceSettingsHtml();
 expect(html).toContain('语音Key');expect(html).toContain('与 API Key 相同');
 expect(html).toContain('value="" maxlength="512" placeholder="abcde••••••vwxyz"');
 expect(html).not.toContain('type="checkbox" checked');
 for (const text of ['data-voice-save-key','data-voice-clear-key','Key 已保存']) expect(html).not.toContain(text);
});
it('committed native configuration supersedes legacy settings without an automatic write', async () => {
 mocks.configuration.mockResolvedValue({...ready,activeConfig:{region:'singapore',workspace:'verified-space',model:'qwen3.8-omni-flash-realtime'}});
 const html = await bailianVoiceSettingsHtml();expect(html).toContain('data-region="singapore"');expect(html).toContain('value="verified-space"');
 expect(mocks.setSetting).not.toHaveBeenCalled();
});
it('workspace edits remain staged and revoke testing without writing settings', () => {
 const field = { id:'voice-bailian-workspace',value:'new-space',dataset:{} } as unknown as HTMLInputElement;
 expect(handleVoiceSettingsChange(field)).toBe(true);expect(field.dataset.voiceDirty).toBe('true');
 expect(mocks.invalidate).toHaveBeenCalledOnce();expect(mocks.setSetting).not.toHaveBeenCalled();
});
it('switching to shared uses only the native masked main summary and discards unsent independent input', () => {
 const key = {value:'unsent-private-key',readOnly:false,placeholder:''};
 const test = {dataset:{maskedMainKey:ready.maskedMainKey,maskedKey:ready.maskedKey}};
 const container = {querySelector:(s:string)=>s==='#voice-bailian-key'?key:test};
 const source = {id:'voice-key-shared',checked:true,dataset:{},closest:()=>container} as unknown as HTMLInputElement;
 handleVoiceSettingsChange(source);expect(key.value).toBe('');expect(key.readOnly).toBe(true);expect(key.placeholder).toBe(ready.maskedMainKey);
 expect(mocks.invalidate).toHaveBeenCalledOnce();expect(mocks.configuration).not.toHaveBeenCalled();expect(mocks.setSetting).not.toHaveBeenCalled();
});
it('region selection updates only its draft and never mutates the active destination', () => {
 const region = {dataset:{region:'beijing'},textContent:'北京'};
 const target = {closest:(s:string)=>s==='#voice-bailian-region'?region:null} as unknown as HTMLElement;
 handleVoiceSettingsClick(target, {} as HTMLElement);
 const options=mocks.pick.mock.calls[0][0];expect(options.selected).toBe('beijing');options.onPick('singapore');
 expect(region.dataset.region).toBe('singapore');expect(region.textContent).toBe('新加坡');expect(mocks.invalidate).toHaveBeenCalledTimes(2);expect(mocks.setSetting).not.toHaveBeenCalled();
});

it('switching from a saved shared key to separate never presents the shared key as an independent saved key', () => {
 const key = {value:'',readOnly:true,placeholder:ready.maskedMainKey};
 const test = {dataset:{keySource:'shared',maskedMainKey:ready.maskedMainKey,maskedKey:ready.maskedMainKey}};
 const container = {querySelector:(s:string)=>s==='#voice-bailian-key'?key:test};
 const source = {id:'voice-key-shared',checked:false,dataset:{},closest:()=>container} as unknown as HTMLInputElement;
 handleVoiceSettingsChange(source);expect(key.value).toBe('');expect(key.readOnly).toBe(false);expect(key.placeholder).toBe('输入语音 Key');
 expect(mocks.setSetting).not.toHaveBeenCalled();
});
