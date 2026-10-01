import { expect, it } from 'vitest';
import { localVoiceRequest, voiceEndpoint } from '../server/voiceBridge';
import type { IncomingMessage } from 'node:http';

function request(origin: string, host = 'localhost:5173', address = '127.0.0.1', marker = '1') {
  return { headers: { origin, host, 'x-gleam-voice': marker }, socket: { remoteAddress: address } } as Pick<IncomingMessage, 'headers' | 'socket'>;
}
it('仅接受同源本机请求，拒绝外站、伪造域名与局域网访问', () => {
  expect(localVoiceRequest(request('http://localhost:5173'))).toBe(true);
  expect(localVoiceRequest(request('https://evil.invalid'))).toBe(false);
  expect(localVoiceRequest(request('http://evil.invalid', 'evil.invalid'))).toBe(false);
  expect(localVoiceRequest(request('http://localhost:5173', 'localhost:5173', '192.168.1.5'))).toBe(false);
  expect(localVoiceRequest(request('http://localhost:5173', 'localhost:5173', '127.0.0.1', ''))).toBe(false);
});
it('出站目的地固定到百炼，不接受任意 URL 或非法业务空间', () => {
  expect(() => voiceEndpoint('beijing', '')).toThrow();
  expect(voiceEndpoint('singapore', 'workspace-1')).toContain('workspace-1.ap-southeast-1.maas.aliyuncs.com');
  expect(() => voiceEndpoint('beijing', 'evil.com/path')).toThrow();
  expect(() => voiceEndpoint('http://localhost', '')).toThrow();
});
