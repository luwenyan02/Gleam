import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({configuration:vi.fn(),testConnection:vi.fn(),commit:vi.fn(),invalidate:vi.fn(),start:vi.fn(),cancel:vi.fn(),toast:vi.fn(),getConfig:vi.fn(),handlers:new Map<string,((payload?:unknown)=>void)[]>(),observers:[] as (()=>void)[]}));
vi.mock('../src/core/nativeSpeech',()=>({nativeSpeech:{configuration:mocks.configuration,testCandidate:mocks.testConnection,commitTestedKey:mocks.commit,invalidateConfiguration:mocks.invalidate,start:mocks.start,cancel:mocks.cancel}}));
vi.mock('../src/core/bailianVoiceConfig',async()=>({...await vi.importActual('../src/core/bailianVoiceConfig'),getBailianVoiceConfig:mocks.getConfig}));
vi.mock('../src/core/store',()=>({on:(name:string,callback:(p?:unknown)=>void)=>{const handlers=mocks.handlers.get(name)??[];handlers.push(callback);mocks.handlers.set(name,handlers);return ()=>{};}}));
vi.mock('../src/features/shell/toast',()=>({showToast:mocks.toast}));
import { mountVoiceConnectionTest, syncVoiceConnectionTest, handleVoiceConnectionTestClick, invalidateVoiceConnectionTest, getVoiceSettingsEpoch, setVoiceTestCredentialWritePending, voiceConnectionTestHtml } from '../src/features/settings/bailianVoiceTestSettings';
const config={region:'beijing',workspace:'synthetic-space',model:'qwen3.8-omni-flash-realtime'};
const readiness={supported:true,hasKey:true,credentialRevision:'synthetic-revision',mainCredentialRevision:'main-revision',keySource:'separate' as const,maskedKey:'abcde••••••vwxyz',hasMainKey:true,maskedMainKey:'main1••••••main2'};
class ElementStub {
 value='';checked=false;placeholder='';disabled=false;hidden=false;textContent='';isConnected=true;dataset:Record<string,string>={};
 nodes=new Map<string,ElementStub>();closest(){return null;}
 querySelector(selector:string):ElementStub {if(!this.nodes.has(selector))this.nodes.set(selector,new ElementStub());return this.nodes.get(selector)!;}
}
let container:ElementStub;let dispose:()=>void;let docEvents:Map<string,()=>void>;let winEvents:Map<string,()=>void>;let hidden=false;
async function flush(){for(let i=0;i<35;i++)await Promise.resolve();}
function click(selector:string){const button=container.querySelector(selector);const target={closest:(s:string)=>s===selector?button:null} as unknown as HTMLElement;expect(handleVoiceConnectionTestClick(target,container as unknown as HTMLElement)).toBe(true);}
function status(){return container.querySelector('[data-voice-test]');}
beforeEach(()=>{
 vi.clearAllMocks();mocks.handlers.clear();mocks.observers=[];docEvents=new Map();winEvents=new Map();hidden=false;
 mocks.configuration.mockResolvedValue(readiness);mocks.getConfig.mockResolvedValue({...config});mocks.cancel.mockResolvedValue(undefined);mocks.invalidate.mockResolvedValue(undefined);mocks.commit.mockResolvedValue({...readiness,credentialRevision:"committed-revision",activeConfig:config});mocks.testConnection.mockImplementation(()=>new Promise(()=>{}));
 vi.stubGlobal('document',{get hidden(){return hidden;},body:{},addEventListener:(e:string,f:()=>void)=>docEvents.set(e,f),removeEventListener:vi.fn()});
 vi.stubGlobal('window',{addEventListener:(e:string,f:()=>void)=>winEvents.set(e,f),removeEventListener:vi.fn()});
 vi.stubGlobal('MutationObserver',class{constructor(callback:()=>void){mocks.observers.push(callback);}observe(){}disconnect(){}});
 container=new ElementStub();container.querySelector('#voice-bailian-workspace').value=config.workspace;container.querySelector('#voice-bailian-model').value=config.model;
 container.querySelector('[data-voice-test]').dataset={supported:'true',hasKey:'true',keySource:'separate',hasMainKey:'true'};
 dispose=mountVoiceConnectionTest(container as unknown as HTMLElement);syncVoiceConnectionTest(container as unknown as HTMLElement);
});
afterEach(()=>{dispose();setVoiceTestCredentialWritePending(false);vi.useRealTimers();vi.unstubAllGlobals();});

it('starts one no-audio candidate from one explicit click and uses the same button to cancel',async()=>{
 expect(mocks.testConnection).not.toHaveBeenCalled();click('[data-voice-test]');await flush();
 expect(mocks.testConnection).toHaveBeenCalledOnce();expect(mocks.testConnection).toHaveBeenCalledWith(expect.objectContaining(config));
 expect(status().textContent).toBe('取消测试');expect(status().disabled).toBe(false);expect(status().dataset.state).toBe('testing');
 expect(mocks.start).not.toHaveBeenCalled();expect(mocks.commit).not.toHaveBeenCalled();
 click('[data-voice-test]');await flush();expect(mocks.cancel).toHaveBeenCalledOnce();expect(status().textContent).toBe('测试语音连接');
});
it('renders one operation only without confirmation/status/diagnostic blocks underneath',()=>{
 const html=voiceConnectionTestHtml(true,true);expect(html.match(/<button/g)).toHaveLength(1);expect(html).toContain('测试语音连接');
 for(const selector of ['data-voice-test-consent','data-voice-test-confirm','data-voice-test-cancel','data-voice-test-status','data-voice-test-copy'])expect(html).not.toContain(selector);
});
it.each(['#voice-bailian-workspace','#voice-bailian-key','#voice-bailian-model'])('editing %s cancels the pending candidate instead of retaining an old success',async selector=>{
 click('[data-voice-test]');await flush();const epoch=getVoiceSettingsEpoch();container.querySelector(selector).value+=' ';
 invalidateVoiceConnectionTest();await flush();expect(getVoiceSettingsEpoch()).toBeGreaterThan(epoch);expect(mocks.cancel).toHaveBeenCalledOnce();expect(status().dataset.state).toBe('idle');expect(mocks.commit).not.toHaveBeenCalled();
});
it('stale preflight resolution after editing cannot start a provider request',async()=>{
 let resolve!:(v:unknown)=>void;mocks.configuration.mockImplementationOnce(()=>new Promise(done=>resolve=done));click('[data-voice-test]');await flush();invalidateVoiceConnectionTest();resolve(readiness);await flush();expect(status().dataset.state).toBe('idle');expect(mocks.testConnection).not.toHaveBeenCalled();
});
it('rechecks credential revision before dispatching the one-click request',async()=>{
 mocks.configuration.mockResolvedValueOnce(readiness).mockResolvedValueOnce({...readiness,credentialRevision:'changed'});click('[data-voice-test]');await flush();
 expect(mocks.testConnection).not.toHaveBeenCalled();expect(status().dataset.state).toBe('error');expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('SPEECH_KEY_CHANGED'),expect.any(Number));
});
it.each(['background','pagehide','navigation','settings','disconnect'])('%s cancels the test and rejects late success without a toast',async trigger=>{
 let resolve!:(v:unknown)=>void;mocks.testConnection.mockImplementationOnce(()=>new Promise(done=>resolve=done));click('[data-voice-test]');await flush();const id=mocks.testConnection.mock.calls[0][0].sessionId;
 if(trigger==='background'){hidden=true;docEvents.get('visibilitychange')!();}else if(trigger==='pagehide')winEvents.get('pagehide')!();else if(trigger==='navigation')mocks.handlers.get('route-changed')![0]();else if(trigger==='settings')mocks.handlers.get('settings-changed')![0]({key:'voice.bailian.model'});else{container.isConnected=false;mocks.observers[0]();}
 expect(mocks.cancel).toHaveBeenCalledWith({sessionId:id});resolve({sessionId:id,connected:true,candidateToken:'late-token'});await flush();expect(status().dataset.state).not.toBe('success');expect(mocks.commit).not.toHaveBeenCalled();expect(mocks.toast).not.toHaveBeenCalled();
});
it('a typed candidate is sent only on the test click, never persisted before success',async()=>{
 container.querySelector('#voice-bailian-key').value='synthetic-private-key';syncVoiceConnectionTest(container as unknown as HTMLElement);expect(mocks.testConnection).not.toHaveBeenCalled();
 click('[data-voice-test]');await flush();expect(mocks.testConnection).toHaveBeenCalledWith(expect.objectContaining({value:'synthetic-private-key',keySource:'separate'}));expect(mocks.commit).not.toHaveBeenCalled();expect(status().textContent).not.toContain('synthetic-private-key');
});
it('invalid staged workspace fails before sending credentials',async()=>{
 container.querySelector('#voice-bailian-workspace').value='invalid space';click('[data-voice-test]');await flush();expect(status().dataset.state).toBe('error');expect(mocks.testConnection).not.toHaveBeenCalled();
});
it('pending main/voice credential writes block testing and never automatically restart it',async()=>{
 setVoiceTestCredentialWritePending(true);click('[data-voice-test]');await flush();expect(mocks.configuration).not.toHaveBeenCalled();setVoiceTestCredentialWritePending(false);await flush();expect(mocks.testConnection).not.toHaveBeenCalled();click('[data-voice-test]');await flush();expect(status().dataset.state).toBe('testing');
});
it('stalled local preflight times out and late readiness cannot start a request',async()=>{
 vi.useFakeTimers();let resolve!:(v:unknown)=>void;mocks.configuration.mockImplementationOnce(()=>new Promise(done=>resolve=done));click('[data-voice-test]');await vi.advanceTimersByTimeAsync(10_000);
 expect(status().dataset.state).toBe('error');expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('SPEECH_TIMEOUT'),expect.any(Number));resolve(readiness);await flush();expect(mocks.testConnection).not.toHaveBeenCalled();
});
it('shows only sanitized diagnostics in the existing toast and never copies or leaks upstream values',async()=>{
 const writeText=vi.fn();vi.stubGlobal('navigator',{clipboard:{writeText}});
 mocks.testConnection.mockRejectedValueOnce({code:'SPEECH_PROTOCOL',message:'PRIVATE_PROVIDER_BODY',data:{phase:'configuring',reason:'ACK_AUDIO_FORMAT_MISSING',reasons:['ACK_AUDIO_FORMAT_MISSING','ACK_TOOLS_NONEMPTY','PRIVATE_KEY'],actual:'PRIVATE_VALUE'}});
 click('[data-voice-test]');await flush();expect(mocks.toast).toHaveBeenCalledOnce();const diagnostic=mocks.toast.mock.calls[0][0];
 expect(diagnostic).toContain('SPEECH_PROTOCOL');expect(diagnostic).toContain('阶段：确认配置');expect(diagnostic).not.toContain('ACK_AUDIO_FORMAT_MISSING');
 expect((status() as unknown as {title:string}).title).toContain('ACK_AUDIO_FORMAT_MISSING');expect((status() as unknown as {title:string}).title).toContain('ACK_TOOLS_NONEMPTY');for(const value of ['PRIVATE',config.workspace,config.model,readiness.credentialRevision])expect(diagnostic).not.toContain(value);
 expect(writeText).not.toHaveBeenCalled();syncVoiceConnectionTest(container as unknown as HTMLElement);expect(mocks.toast).toHaveBeenCalledOnce();
});
it('successful commit clears the raw field and announces once through the existing toast',async()=>{
 mocks.testConnection.mockImplementationOnce(async options=>({sessionId:options.sessionId,connected:true,candidateToken:'candidate-once'}));container.querySelector('#voice-bailian-key').value='synthetic-private-key';
 click('[data-voice-test]');await flush();expect(mocks.commit).toHaveBeenCalledOnce();expect(status().dataset.state).toBe('success');expect(container.querySelector('#voice-bailian-key').value).toBe('');expect(container.querySelector('#voice-bailian-key').placeholder).toBe(readiness.maskedKey);
 expect(mocks.toast).toHaveBeenCalledOnce();expect(mocks.toast.mock.calls[0][0]).toContain('录音未测试');syncVoiceConnectionTest(container as unknown as HTMLElement);expect(mocks.toast).toHaveBeenCalledOnce();
});
it('shared mode never forwards a JS key and main-key edits revoke the pending test',async()=>{
 container.querySelector('#voice-key-shared').checked=true;container.querySelector('#voice-bailian-key').value='ignored-independent-draft';click('[data-voice-test]');await flush();
 expect(mocks.testConnection.mock.calls[0][0].value).toBeUndefined();expect(mocks.testConnection.mock.calls[0][0].keySource).toBe('shared');mocks.handlers.get('settings-changed')![0]({key:'ai.apiKey'});expect(mocks.cancel).toHaveBeenCalledOnce();expect(mocks.commit).not.toHaveBeenCalled();
});
it('cancels a stalled native authority check with the same button and never starts on its late completion',async()=>{
 let resolve!:()=>void;mocks.invalidate.mockImplementationOnce(()=>new Promise<void>(done=>resolve=done));invalidateVoiceConnectionTest();click('[data-voice-test]');await flush();expect(status().textContent).toBe('取消测试');
 click('[data-voice-test]');resolve();await flush();expect(mocks.testConnection).not.toHaveBeenCalled();expect(mocks.commit).not.toHaveBeenCalled();
});
it('rejects unsupported models without falling back or sending a request',async()=>{
 container.querySelector('#voice-bailian-model').value='qwen3.5-omni-plus-realtime';click('[data-voice-test]');await flush();expect(status().dataset.state).toBe('error');expect(mocks.testConnection).not.toHaveBeenCalled();
});

it('bounds a worst-case multi-reason toast to code and phase while retaining the sanitized full title',async()=>{
 const reasons=['ACK_SESSION_MISSING','ACK_SESSION_NULL','ACK_SESSION_TYPE','ACK_MODEL_TYPE','ACK_MODEL_MISMATCH','ACK_TURN_DETECTION_MISSING','ACK_TURN_DETECTION_TYPE','ACK_TURN_DETECTION_MISMATCH','ACK_MODALITIES_MISSING','ACK_MODALITIES_TYPE','ACK_MODALITIES_MISMATCH','ACK_TRANSCRIPTION_MISSING','ACK_TRANSCRIPTION_TYPE','ACK_TRANSCRIPTION_MODEL_MISSING','ACK_TRANSCRIPTION_MODEL_TYPE','ACK_AUDIO_INPUT_MISSING','ACK_AUDIO_INPUT_TYPE','ACK_AUDIO_FORMAT_MISSING','ACK_AUDIO_FORMAT_TYPE','ACK_AUDIO_ENCODING_MISSING','ACK_AUDIO_ENCODING_TYPE','ACK_AUDIO_ENCODING_MISMATCH','ACK_SAMPLE_RATE_MISSING','ACK_SAMPLE_RATE_TYPE'];
 mocks.testConnection.mockRejectedValueOnce({code:'SPEECH_PROTOCOL',data:{phase:'configuring',reasons}});click('[data-voice-test]');await flush();
 const text=mocks.toast.mock.calls[0][0];expect(text.length).toBeLessThan(100);expect(text).toContain('SPEECH_PROTOCOL');expect(text).toContain('阶段：确认配置');
 const title=(status() as unknown as {title:string}).title;expect(title.length).toBeGreaterThan(500);for(const reason of reasons)expect(title).toContain(reason);
});
