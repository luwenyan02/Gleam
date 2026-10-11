import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { shortVoiceError } from '../src/core/bailianVoiceErrors';

const nativeReasons = [
  'ACK_SESSION_MISSING', 'ACK_SESSION_NULL', 'ACK_SESSION_TYPE', 'ACK_MODEL_TYPE', 'ACK_MODEL_MISMATCH',
  'ACK_TURN_DETECTION_MISSING', 'ACK_TURN_DETECTION_TYPE', 'ACK_TURN_DETECTION_MISMATCH',
  'ACK_MODALITIES_MISSING', 'ACK_MODALITIES_TYPE', 'ACK_MODALITIES_MISMATCH',
  'ACK_TRANSCRIPTION_MISSING', 'ACK_TRANSCRIPTION_TYPE', 'ACK_TRANSCRIPTION_MODEL_MISSING',
  'ACK_TRANSCRIPTION_MODEL_TYPE', 'ACK_TRANSCRIPTION_MODEL_MISMATCH',
  'ACK_AUDIO_MISSING', 'ACK_AUDIO_TYPE', 'ACK_AUDIO_INPUT_MISSING', 'ACK_AUDIO_INPUT_TYPE',
  'ACK_AUDIO_FORMAT_MISSING', 'ACK_AUDIO_FORMAT_TYPE', 'ACK_AUDIO_ENCODING_MISSING',
  'ACK_AUDIO_ENCODING_TYPE', 'ACK_AUDIO_ENCODING_MISMATCH', 'ACK_SAMPLE_RATE_MISSING',
  'ACK_SAMPLE_RATE_TYPE', 'ACK_SAMPLE_RATE_MISMATCH', 'ACK_SEARCH_TYPE', 'ACK_SEARCH_ENABLED',
  'ACK_TOOLS_TYPE', 'ACK_TOOLS_NONEMPTY', 'ACK_CHANNELS_TYPE', 'ACK_CHANNELS_MISMATCH',
  'ACK_SAMPLE_FORMAT_TYPE', 'ACK_SAMPLE_FORMAT_MISMATCH', 'ACK_PACKING_TYPE', 'ACK_PACKING_MISMATCH',
  'ACK_CHANNEL_LAYOUT_TYPE', 'ACK_CHANNEL_LAYOUT_MISMATCH', 'ACK_UNSAFE_CONFIGURATION',
  'FRAME_MALFORMED_JSON', 'FRAME_OVERSIZED', 'FRAME_BINARY', 'FRAME_PROCESSING_FAILED',
  'COMMIT_ITEM_ID_INVALID', 'COMMIT_ITEM_ID_CONFLICT', 'TRANSCRIPT_ITEM_ID_CONFLICT', 'PROTOCOL_UNCLASSIFIED',
  'ACK_SERVER_SESSION_ID_TYPE', 'ACK_SERVER_SESSION_ID_INVALID', 'ACK_SERVER_SESSION_ID_MISMATCH',
  'ACK_UNEXPECTED_SESSION_EVENT', 'ACK_NESTED_TURN_DETECTION', 'UNEXPECTED_VAD_EVENT', 'UNEXPECTED_RESPONSE_EVENT',
];

it.each(nativeReasons)('maps native reason %s to a fixed Chinese description without raw fields', reason => {
  const message = shortVoiceError({ code: 'SPEECH_PROTOCOL', message: 'PRIVATE_PROVIDER_BODY', data: {
    phase: 'configuring', reason, actual: 'PRIVATE_OBSERVED_VALUE', expected: 'PRIVATE_EXPECTED_VALUE',
    model: 'PRIVATE_MODEL', workspace: 'PRIVATE_WORKSPACE', key: 'fixture-PRIVATE_KEY',
  } });
  expect(message).toContain(reason);
  expect(message).toMatch(/原因：[\u3400-\u9fff]/);
  expect(message).not.toContain('PRIVATE');
  expect(message).not.toContain('PROTOCOL_REASON_UNKNOWN');
});

it('deduplicates ordered allowlisted reasons and ignores unknown data while showing simultaneous failures', () => {
  const message = shortVoiceError({ code: 'SPEECH_PROTOCOL', data: { phase: 'configuring', reason: 'ACK_MODALITIES_MISMATCH',
    reasons: ['ACK_MODALITIES_MISMATCH', 'PRIVATE_REASON', 'ACK_SAMPLE_RATE_MISMATCH', null, '__proto__', 'ACK_TOOLS_NONEMPTY'] } });
  expect(message.match(/ACK_MODALITIES_MISMATCH/g)).toHaveLength(1);
  expect(message).toContain('ACK_SAMPLE_RATE_MISMATCH');
  expect(message).toContain('ACK_TOOLS_NONEMPTY');
  expect(message).not.toContain('PRIVATE');
  expect(message).not.toContain('__proto__');
  expect(message).not.toContain('PROTOCOL_REASON_UNKNOWN');
});

it('caps the reason list to 24 fixed codes and never includes extra values', () => {
  const message = shortVoiceError({ code: 'SPEECH_PROTOCOL', data: { reason: nativeReasons[0], reasons: nativeReasons } });
  const displayed = nativeReasons.filter(reason => message.includes(reason));
  expect(displayed).toHaveLength(24);
  expect(displayed).toEqual(nativeReasons.slice(0, 24));
  expect(message).toContain('仅显示前24项');
});

it.each([{ reasons: ['fixture-PRIVATE_KEY', 'PRIVATE_REASON', 5, null] }, { reasons: 'PRIVATE_REASON' },
  { reasons: { reason: 'PRIVATE_REASON' } }, { reasons: [] }])(
  'uses fixed unknown text when reasons contains no valid entry: %s', ({ reasons }) => {
    const message = shortVoiceError({ code: 'SPEECH_PROTOCOL', data: { phase: 'PRIVATE_PHASE', reason: 'PRIVATE_REASON', reasons } });
    expect(message).toContain('PROTOCOL_REASON_UNKNOWN');
    expect(message).not.toContain('PRIVATE');
  },
);

it('covers the exact native enum vocabulary so Android/frontend diagnostics cannot drift silently', () => {
  const source = readFileSync('android/app/src/main/java/com/gleam/shiguang/GleamSpeechProtocolReason.java', 'utf8');
  const declaration = source.match(/enum GleamSpeechProtocolReason\s*\{([\s\S]*?);/);
  expect(declaration).not.toBeNull();
  const nativeVocabulary = declaration![1].match(/\b[A-Z][A-Z0-9_]+\b/g);
  expect(nativeVocabulary).toEqual(nativeReasons);
});

it.each([
  ['ACK_SERVER_SESSION_ID_TYPE', '服务端会话标识的字段类型不符'],
  ['ACK_SERVER_SESSION_ID_INVALID', '服务端会话标识格式无效'],
  ['ACK_SERVER_SESSION_ID_MISMATCH', '服务端会话标识前后不一致'],
  ['ACK_UNEXPECTED_SESSION_EVENT', '会话事件顺序或确认状态不符'],
  ['ACK_NESTED_TURN_DETECTION', '嵌套音频配置的轮次检测未关闭'],
  ['UNEXPECTED_VAD_EVENT', '手动模式收到自动语音检测事件'],
  ['UNEXPECTED_RESPONSE_EVENT', '收到未经请求的模型响应事件'],
])('manual-ACK diagnostic %s keeps server identifiers and configuration values private', (reason, description) => {
  const message = shortVoiceError({ code: 'SPEECH_PROTOCOL', data: {
    phase: 'configuring', reason, reasons: [reason, 'fixture-PRIVATE_REASON'],
    sessionId: 'fixture-PRIVATE_SESSION', actual: { id: 'fixture-PRIVATE_ACTUAL', turn_detection: 'fixture-PRIVATE_MODE' },
    expected: 'fixture-PRIVATE_EXPECTED',
  } });
  expect(message).toContain(description);
  expect(message).toContain(reason);
  expect(message).not.toContain('PRIVATE');
  expect(message).not.toContain('核对模型');
});
