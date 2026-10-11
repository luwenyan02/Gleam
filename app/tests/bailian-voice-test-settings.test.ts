import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({configuration:vi.fn(),testConnection:vi.fn(),start:vi.fn(),cancel:vi.fn(),getConfig:vi.fn(),handlers:new Map<string,((payload?:unknown)=>void)[]>(),observers:[] as (()=>void)[]}));
vi.mock('../src/core/nativeSpeech',()=>({nativeSpeech:{configuration:mocks.configuration,testConnection:mocks.testConnection,start:mocks.start,cancel:mocks.cancel}}));
vi.mock('../src/core/bailianVoiceConfig',async()=>({...await vi.importActual('../src/core/bailianVoiceConfig'),getBailianVoiceConfig:mocks.getConfig}));
vi.mock('../src/core/store',()=>({on:(name:string,callback:(p?:unknown)=>void)=>{const handlers=mocks.handlers.get(name)??[];handlers.push(callback);mocks.handlers.set(name,handlers);return ()=>{};}}));
import { mountVoiceConnectionTest, syncVoiceConnectionTest, handleVoiceConnectionTestClick, invalidateVoiceConnectionTest, getVoiceSettingsEpoch, setVoiceTestCredentialWritePending, voiceConnectionTestHtml } from '../src/features/settings/bailianVoiceTestSettings';
const config={region:'beijing',workspace:'synthetic-space',model:'qwen3.8-omni-flash-realtime'};
const readiness={supported:true,hasKey:true,credentialRevision:'synthetic-revision'};
class ElementStub {
 value='';disabled=false;hidden=false;textContent='';isConnected=true;dataset:Record<string,string>={};
 nodes=new Map<string,ElementStub>();closest(){return null;}
 querySelector(selector:string):ElementStub {if(!this.nodes.has(selector))this.nodes.set(selector,new ElementStub());return this.nodes.get(selector)!;}
}
let container:ElementStub;let dispose:()=>void;let docEvents:Map<string,()=>void>;let winEvents:Map<string,()=>void>;let hidden=false;
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
function click(selector:string){const button=container.querySelector(selector);const target={closest:(s:string)=>s===selector?button:null} as unknown as HTMLElement;expect(handleVoiceConnectionTestClick(target,container as unknown as HTMLElement)).toBe(true);}
function status(){return container.querySelector('[data-voice-test-status]');}
beforeEach(()=>{
 vi.clearAllMocks();mocks.handlers.clear();mocks.observers=[];docEvents=new Map();winEvents=new Map();hidden=false;
 mocks.configuration.mockResolvedValue(readiness);mocks.getConfig.mockResolvedValue({...config});mocks.cancel.mockResolvedValue(undefined);mocks.testConnection.mockImplementation(()=>new Promise(()=>{}));
 vi.stubGlobal('document',{get hidden(){return hidden;},body:{},addEventListener:(e:string,f:()=>void)=>docEvents.set(e,f),removeEventListener:vi.fn()});
 vi.stubGlobal('window',{addEventListener:(e:string,f:()=>void)=>winEvents.set(e,f),removeEventListener:vi.fn()});
 vi.stubGlobal('MutationObserver',class{constructor(callback:()=>void){mocks.observers.push(callback);}observe(){}disconnect(){}});
 container=new ElementStub();container.querySelector('#voice-bailian-workspace').value=config.workspace;container.querySelector('#voice-bailian-model').value=config.model;
 container.querySelector('[data-voice-test]').dataset={supported:'true',hasKey:'true'};
 dispose=mountVoiceConnectionTest(container as unknown as HTMLElement);syncVoiceConnectionTest(container as unknown as HTMLElement);
});
afterEach(()=>{dispose();setVoiceTestCredentialWritePending(false);vi.useRealTimers();vi.unstubAllGlobals();});
it('requires test click and a second explicit consent; shows recipient and preserves state through refresh',async()=>{
 expect(mocks.testConnection).not.toHaveBeenCalled();click('[data-voice-test]');await flush();
 expect(mocks.testConnection).not.toHaveBeenCalled();expect(status().dataset.state).toBe('consent');expect(container.querySelector('[data-voice-test-recipient]').textContent).toContain('阿里云百炼 · 北京');

 syncVoiceConnectionTest(container as unknown as HTMLElement);expect(status().dataset.state).toBe('consent');click('[data-voice-test-confirm]');await flush();expect(mocks.testConnection).toHaveBeenCalledOnce();expect(mocks.testConnection).toHaveBeenCalledWith(expect.objectContaining(config));expect(mocks.start).not.toHaveBeenCalled();
});
it.each(['#voice-bailian-workspace','#voice-bailian-key','#voice-bailian-model'])('raw %s input revokes a displayed consent and advances render epoch',async selector=>{
 click('[data-voice-test]');await flush();const epoch=getVoiceSettingsEpoch();container.querySelector(selector).value+=' ';
 invalidateVoiceConnectionTest();expect(getVoiceSettingsEpoch()).toBeGreaterThan(epoch);click('[data-voice-test-confirm]');await flush();expect(mocks.testConnection).not.toHaveBeenCalled();expect(status().dataset.state).toBe('idle');
});
it('stale preflight resolution after raw input cannot restore consent',async()=>{
 let resolve!:(v:unknown)=>void;mocks.configuration.mockImplementationOnce(()=>new Promise(done=>resolve=done));click('[data-voice-test]');invalidateVoiceConnectionTest();resolve(readiness);await flush();expect(status().dataset.state).toBe('idle');expect(container.querySelector('[data-voice-test-consent]').hidden).toBe(true);
});
it('credential change during confirm validation is rejected before any provider request',async()=>{
 click('[data-voice-test]');await flush();mocks.configuration.mockResolvedValue({...readiness,credentialRevision:'changed'});click('[data-voice-test-confirm]');await flush();expect(mocks.testConnection).not.toHaveBeenCalled();expect(status().textContent).toContain('SPEECH_KEY_CHANGED');
});
it.each(['background','pagehide','navigation','settings','disconnect'])('%s cancels in-flight test and rejects a late success',async trigger=>{
 let resolve!:(v:unknown)=>void;mocks.testConnection.mockImplementationOnce(()=>new Promise(done=>resolve=done));click('[data-voice-test]');await flush();click('[data-voice-test-confirm]');await flush();const id=mocks.testConnection.mock.calls[0][0].sessionId;
 if(trigger==='background'){hidden=true;docEvents.get('visibilitychange')!();}else if(trigger==='pagehide')winEvents.get('pagehide')!();else if(trigger==='navigation')mocks.handlers.get('route-changed')![0]();else if(trigger==='settings')mocks.handlers.get('settings-changed')![0]({key:'voice.bailian.model'});else{container.isConnected=false;mocks.observers[0]();}
 expect(mocks.cancel).toHaveBeenCalledWith({sessionId:id});resolve({sessionId:id,connected:true});await flush();expect(status().dataset.state).not.toBe('success');expect(mocks.testConnection).toHaveBeenCalledOnce();
});
it('a new raw key or workspace mismatch prevents consent and never transmits draft credentials',async()=>{
 container.querySelector('#voice-bailian-key').value='synthetic-private-key';click('[data-voice-test]');await flush();expect(status().dataset.state).toBe('error');expect(mocks.testConnection).not.toHaveBeenCalled();expect(status().textContent).not.toContain('synthetic-private-key');
 container.querySelector('#voice-bailian-key').value='';container.querySelector('#voice-bailian-workspace').value='different';click('[data-voice-test]');await flush();expect(status().dataset.state).toBe('error');expect(mocks.testConnection).not.toHaveBeenCalled();
});

it('test confirmation is a compact explicit action, without routine tutorial prose',()=>{
 const html=voiceConnectionTestHtml(true,true);expect(html).toContain('开始测试');expect(html).toContain('data-voice-test-consent');expect(html).not.toContain('可能产生服务商费用');expect(html).not.toContain('鉴权与会话配置请求');
});
it('pending credential writes block testing until a new explicit click after completion',async()=>{
 setVoiceTestCredentialWritePending(true);click('[data-voice-test]');await flush();expect(mocks.configuration).not.toHaveBeenCalled();setVoiceTestCredentialWritePending(false);await flush();expect(mocks.testConnection).not.toHaveBeenCalled();click('[data-voice-test]');await flush();expect(status().dataset.state).toBe('consent');
});
it('a stalled local preflight times out and cannot restore consent later',async()=>{
 vi.useFakeTimers();let resolve!:(value:unknown)=>void;mocks.configuration.mockImplementationOnce(()=>new Promise(done=>resolve=done));click('[data-voice-test]');await vi.advanceTimersByTimeAsync(10_000);expect(status().dataset.state).toBe('error');expect(status().textContent).toContain('SPEECH_TIMEOUT');resolve(readiness);await flush();expect(status().dataset.state).toBe('error');expect(mocks.testConnection).not.toHaveBeenCalled();
});

it('copies only the sanitized diagnostic after an explicit click, never recipient/config/keys or upstream values', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  mocks.testConnection.mockRejectedValueOnce({ code: 'SPEECH_PROTOCOL', message: 'PRIVATE_PROVIDER_BODY', data: {
    phase: 'configuring', reason: 'ACK_AUDIO_FORMAT_MISSING', reasons: ['ACK_AUDIO_FORMAT_MISSING', 'ACK_TOOLS_NONEMPTY', 'fixture-PRIVATE_KEY'],
    actual: 'PRIVATE_VALUE', workspace: 'PRIVATE_WORKSPACE',
  } });
  click('[data-voice-test]'); await flush();
  expect(writeText).not.toHaveBeenCalled();
  click('[data-voice-test-confirm]'); await flush();
  expect(writeText).not.toHaveBeenCalled();
  expect(container.querySelector('[data-voice-test-copy]').hidden).toBe(false);
  const diagnostic = status().textContent;
  // Never copy editable DOM text, even if other code mutates it.
  status().textContent = 'PRIVATE_DOM_TEXT';
  click('[data-voice-test-copy]'); await flush();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(diagnostic);
  expect(diagnostic).toContain('ACK_AUDIO_FORMAT_MISSING');
  expect(diagnostic).toContain('ACK_TOOLS_NONEMPTY');
  for (const privateValue of ['PRIVATE', config.workspace, config.model, readiness.credentialRevision]) expect(diagnostic).not.toContain(privateValue);
  expect(container.querySelector('[data-voice-test-copy-status]').textContent).toContain('已复制');
});

it('idle/consent states cannot copy anything and clipboard failures never echo their exception', async () => {
  const writeText = vi.fn().mockRejectedValue(new Error('PRIVATE_CLIPBOARD_ERROR'));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  click('[data-voice-test-copy]'); await flush(); expect(writeText).not.toHaveBeenCalled();
  click('[data-voice-test]'); await flush();
  click('[data-voice-test-copy]'); await flush(); expect(writeText).not.toHaveBeenCalled();
  mocks.testConnection.mockRejectedValueOnce({ code: 'SPEECH_PROTOCOL', data: { phase: 'configuring', reason: 'ACK_SAMPLE_RATE_MISMATCH' } });
  click('[data-voice-test-confirm]'); await flush();
  click('[data-voice-test-copy]'); await flush();
  expect(writeText).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-voice-test-copy-status]').textContent).toContain('复制失败');
  expect(container.querySelector('[data-voice-test-copy-status]').textContent).not.toContain('PRIVATE');
  invalidateVoiceConnectionTest();
  expect(container.querySelector('[data-voice-test-copy]').hidden).toBe(true);
});

