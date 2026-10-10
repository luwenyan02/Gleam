import { expect, it } from 'vitest';
import { shortVoiceError } from '../src/core/bailianVoiceSession';
const codes = ['SPEECH_UNSUPPORTED','SPEECH_CONSENT_REQUIRED','SPEECH_KEY_REQUIRED','SPEECH_KEY_CHANGED','SPEECH_KEY_STORAGE','SPEECH_PERMISSION_DENIED','SPEECH_PERMISSION_CANCELLED','SPEECH_BUSY','SPEECH_CONFIG_INVALID','SPEECH_AUTH','SPEECH_RATE_LIMIT','SPEECH_LIMIT','SPEECH_TRANSCRIPT_LIMIT','SPEECH_AUDIO_EMPTY','SPEECH_TIMEOUT','SPEECH_TLS','SPEECH_NETWORK','SPEECH_AUDIO_UNAVAILABLE','SPEECH_INTERRUPTED','SPEECH_CANCELLED','SPEECH_SESSION_INVALID','SPEECH_TRANSCRIPTION_FAILED','SPEECH_PROTOCOL','SPEECH_PROVIDER'];
it.each(codes)('%s uses fixed safe text, code and an allowlisted phase', code => {
 const message=shortVoiceError({code,message:'PRIVATE_UPSTREAM_KEY',data:{phase:'connecting',response:'PRIVATE_BODY'}});
 expect(message).toContain(code);expect(message).toContain('连接服务');expect(message).not.toContain('PRIVATE');
});
it.each(['validation','permission','connecting','configuring','microphone','transcribing'])('allows only phase %s',phase=>{
 expect(shortVoiceError({code:'SPEECH_UNKNOWN_PRIVATE',data:{phase}})).toContain('阶段：');expect(shortVoiceError({code:'SPEECH_UNKNOWN_PRIVATE',data:{phase}})).not.toContain('PRIVATE');
});
it('rejects unknown codes and phases without displaying upstream fields',()=>{
 for(const error of [undefined,new Error('PRIVATE'),{code:'constructor',data:{phase:'constructor'}},{code:'PRIVATE_KEY',phase:'PRIVATE_PHASE',data:{phase:'PRIVATE_PHASE'}},{code:{toString:()=>'PRIVATE'}}]){
 expect(shortVoiceError(error)).not.toContain('PRIVATE');expect(shortVoiceError(error)).not.toContain('constructor');expect(shortVoiceError(error)).toContain('语音未完成');}
});

it('protocol errors avoid suggesting a model/configuration change before the failing check is known', () => {
  const message = shortVoiceError({ code: 'SPEECH_PROTOCOL', data: { phase: 'configuring' } });
  expect(message).toContain('会话配置核验未通过，已安全停止');
  expect(message).not.toContain('核对模型');
  expect(message).toContain('PROTOCOL_REASON_UNKNOWN');
});

it.each([undefined, null, '', 'constructor', '__proto__', 'fixture-SYNTHETIC_PRIVATE_KEY',
  { field: 'SYNTHETIC_PRIVATE_FIELD' }, ['SYNTHETIC_PRIVATE_VALUE']])('unknown protocol reason is sanitized: %s', reason => {
  const message = shortVoiceError({ code: 'SPEECH_PROTOCOL', message: 'SYNTHETIC_PRIVATE_MESSAGE',
    data: { phase: 'configuring', reason, actual: 'SYNTHETIC_PRIVATE_ACTUAL', expected: 'SYNTHETIC_PRIVATE_EXPECTED' } });
  expect(message).toContain('PROTOCOL_REASON_UNKNOWN');
  expect(message).not.toContain('SYNTHETIC_PRIVATE');
  expect(message).not.toContain('constructor');
  expect(message).not.toContain('__proto__');
});

it('unknown private sentinel code, phase and reason are never copied into diagnostics', () => {
  const message = shortVoiceError({ code: 'fixture-SYNTHETIC_PRIVATE_CODE', message: 'SYNTHETIC_PRIVATE_MESSAGE',
    data: { phase: 'fixture-SYNTHETIC_PRIVATE_PHASE', reason: 'fixture-SYNTHETIC_PRIVATE_REASON', value: 'SYNTHETIC_PRIVATE_VALUE' } });
  expect(message).toContain('SPEECH_UNKNOWN');
  expect(message).toContain('阶段：未确定');
  expect(message).toContain('PROTOCOL_REASON_UNKNOWN');
  expect(message).not.toContain('SYNTHETIC_PRIVATE');
});
