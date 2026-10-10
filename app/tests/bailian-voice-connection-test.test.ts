import { afterEach, expect, it, vi } from 'vitest';
import { BailianVoiceConnectionTest } from '../src/core/bailianVoiceConnectionTest';
import { BailianVoiceSession } from '../src/core/bailianVoiceSession';
import { BAILIAN_VOICE_MODEL } from '../src/core/bailianVoiceConfig';
import type { NativeSpeechPlugin, NativeSpeechConnectionResult } from '../src/core/nativeSpeech';
const config={region:'beijing' as const,workspace:'synthetic',model:BAILIAN_VOICE_MODEL};
const readiness={supported:true,hasKey:true,credentialRevision:'synthetic-revision'};
function setup(){
 const pending:{resolve(value:NativeSpeechConnectionResult):void;reject(error:unknown):void}[]=[];
 const bridge={testConnection:vi.fn(()=>new Promise<NativeSpeechConnectionResult>((resolve,reject)=>{pending.push({resolve,reject});})),start:vi.fn(),addListener:vi.fn(async()=>({remove:vi.fn(async()=>{})})),cancel:vi.fn(async()=>{})} as unknown as NativeSpeechPlugin;
 const changed=vi.fn();const test=new BailianVoiceConnectionTest(bridge,changed);
 return {test,bridge,changed,pending,id:()=>vi.mocked(bridge.testConnection).mock.calls.at(-1)![0].sessionId};
}
afterEach(()=>vi.useRealTimers());
it('calls only the explicit no-audio API once, and success describes only the tested scope',async()=>{
 const s=setup();expect(s.bridge.testConnection).not.toHaveBeenCalled();const run=s.test.start(config,readiness);await s.test.start(config,readiness);
 expect(s.bridge.testConnection).toHaveBeenCalledOnce();expect(s.bridge.start).not.toHaveBeenCalled();expect(s.bridge.testConnection).toHaveBeenCalledWith({...config,sessionId:s.id(),expectedCredentialRevision:readiness.credentialRevision,consent:true,userInitiated:true});
 s.pending[0].resolve({sessionId:s.id(),connected:true});await run;expect(s.test.state).toBe('success');expect(s.test.message).toContain('未测试麦克风或转写');expect(s.test.busy).toBe(false);
});
it('invalidating config or raw drafts cancels and ignores late results, including after another run starts',async()=>{
 const s=setup();const first=s.test.start(config,readiness);const old=s.id();s.test.invalidate();expect(s.bridge.cancel).toHaveBeenCalledWith({sessionId:old});
 const next=s.test.start(config,readiness);const current=s.id();s.pending[0].resolve({sessionId:old,connected:true});await first;expect(s.test.state).toBe('testing');
 s.pending[1].resolve({sessionId:current,connected:true});await next;s.test.invalidate();expect(s.test.state).toBe('idle');expect(s.test.message).not.toContain('验证通过');
});
it('timeout is bounded, cancels native work, and never accepts a late successful result',async()=>{
 vi.useFakeTimers();const s=setup();const run=s.test.start(config,readiness);const id=s.id();await vi.advanceTimersByTimeAsync(35_000);expect(s.bridge.cancel).toHaveBeenCalledWith({sessionId:id});expect(s.test.state).toBe('error');expect(s.test.message).toContain('SPEECH_TIMEOUT');
 s.pending[0].resolve({sessionId:id,connected:true});await run;expect(s.test.state).toBe('error');
});
it('background/disposal cancels without automatically restarting or repainting stale success',async()=>{
 const s=setup();const run=s.test.start(config,readiness);const id=s.id();s.test.dispose();const count=s.changed.mock.calls.length;s.pending[0].resolve({sessionId:id,connected:true});await run;await s.test.start(config,readiness);expect(s.bridge.testConnection).toHaveBeenCalledOnce();expect(s.bridge.cancel).toHaveBeenCalledOnce();expect(s.changed).toHaveBeenCalledTimes(count);
});
it('rejects mismatched native session IDs, malformed success and safe native errors',async()=>{
 const s=setup();let run=s.test.start(config,readiness);s.pending[0].resolve({sessionId:'wrong',connected:true});await run;expect(s.test.state).toBe('error');expect(s.test.message).toContain('SPEECH_SESSION_INVALID');
 run=s.test.start(config,readiness);s.pending[1].resolve({sessionId:s.id(),connected:false as never});await run;expect(s.test.message).toContain('SPEECH_PROTOCOL');
 run=s.test.start(config,readiness);s.pending[2].reject({code:'SPEECH_AUTH',message:'PRIVATE',data:{phase:'configuring'}});await run;expect(s.test.message).toContain('确认配置');expect(s.test.message).not.toContain('PRIVATE');
});
it('frontend guard excludes normal recording and connection tests in both directions',async()=>{
 const s=setup();const callbacks={onState:vi.fn(),onText:vi.fn(),onError:vi.fn()};const recording=new BailianVoiceSession(s.bridge,callbacks);const run=s.test.start(config,readiness);await recording.start(config,readiness);expect(s.bridge.start).not.toHaveBeenCalled();expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('SPEECH_BUSY'));
 s.test.invalidate();s.pending[0].resolve({sessionId:s.id(),connected:true});await run;vi.mocked(s.bridge.start).mockImplementation(()=>new Promise(()=>{}));void recording.start(config,readiness);await Promise.resolve();await s.test.start(config,readiness);expect(s.bridge.testConnection).toHaveBeenCalledOnce();expect(s.test.message).toContain('SPEECH_BUSY');recording.dispose();
});
it('missing native readiness and invalid local configuration never start a request',async()=>{
 const s=setup();await s.test.start(config,{...readiness,supported:false});await s.test.start(config,{...readiness,hasKey:false});await s.test.start({...config,workspace:'evil/path'},readiness);expect(s.bridge.testConnection).not.toHaveBeenCalled();
});
