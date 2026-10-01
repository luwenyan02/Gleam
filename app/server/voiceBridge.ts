import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

export const VOICE_MODELS = ['qwen3.8-omni-flash-realtime', 'qwen-audio-3.1-realtime-plus', 'qwen3.5-omni-plus-realtime'];
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function voiceEndpoint(region: string, workspace: string): string {
  if (!['beijing', 'singapore'].includes(region) || typeof workspace !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(workspace)) throw new Error('invalid destination');
  const host = `${workspace}.${region === 'beijing' ? 'cn-beijing' : 'ap-southeast-1'}.maas.aliyuncs.com`;
  return `https://${host}/api/v1/webrtc/realtime`;
}

export function localVoiceRequest(req: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  if (!loopback.has(req.socket.remoteAddress ?? '') || req.headers['x-gleam-voice'] !== '1') return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    const origin = new URL(String(req.headers.origin));
    return ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) && origin.host === host.host && origin.protocol === 'http:';
  } catch { return false; }
}

/** 仅 Vite 本地开发服务器启用；不打包进 PWA，不向页面交付 API Key。 */
export function voiceBridge(defaultWorkspace = ''): Plugin {
  let pending = false;
  const starts: number[] = [];
  return { name: 'gleam-local-voice', configureServer(server) {
    server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
      const path = req.url?.split('?')[0];
      if (!path?.startsWith('/__gleam/voice/')) return next();
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      const reply = (status: number, error: string) => { if (!res.destroyed) { res.statusCode = status; res.end(JSON.stringify({ error })); } };
      if (!localVoiceRequest(req)) return reply(403, '仅允许本机拾光页面使用语音中转');
      if (path === '/__gleam/voice/config' && req.method === 'POST') {
        res.end(JSON.stringify({ configured: !!process.env.DASHSCOPE_API_KEY?.trim(), workspace: process.env.DASHSCOPE_WORKSPACE_ID ?? defaultWorkspace, models: VOICE_MODELS })); return;
      }
      if (path !== '/__gleam/voice/session' || req.method !== 'POST') return reply(404, '接口不存在');
      if (!process.env.DASHSCOPE_API_KEY?.trim()) return reply(503, '请设置 DASHSCOPE_API_KEY 并重启本地网页服务');
      if (req.headers['content-type'] !== 'application/json') return reply(415, '请求格式无效');
      while (starts.length && starts[0] < Date.now() - 60_000) starts.shift();
      if (pending || starts.length >= 5) return reply(429, '连接过于频繁，请稍后重试');
      pending = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.on('close', abort);
      const timer = setTimeout(abort, 25_000);
      try {
        let body = '';
        for await (const chunk of req) { body += chunk.toString(); if (body.length > 64_000) return reply(413, '连接数据过大'); }
        let data: { model: string; region: string; workspace: string; sdp: string };
        try { data = JSON.parse(body); } catch { return reply(400, '请求格式无效'); }
        if (!data || !VOICE_MODELS.includes(data.model) || typeof data.sdp !== 'string' || !data.sdp.startsWith('v=0') || !data.sdp.includes('m=audio')) return reply(400, '语音模型或连接数据无效');
        let endpoint: string;
        try { endpoint = voiceEndpoint(data.region, data.workspace); } catch { return reply(400, '地域或业务空间无效'); }
        starts.push(Date.now());
        const upstream = await fetch(`${endpoint}?model=${encodeURIComponent(data.model)}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY!.trim()}` }, body: data.sdp,
        });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          return reply(502, `百炼连接失败（${upstream.status}），请检查模型权限、Key 地域与业务空间`);
        }
        const sdp = await upstream.text();
        if (!sdp.startsWith('v=0') || sdp.length > 128_000) return reply(502, '百炼返回的连接信息无效');
        if (!res.destroyed) res.end(JSON.stringify({ sdp }));
      } catch { reply(502, controller.signal.aborted ? '语音连接已取消或超时' : '语音服务暂时无法连接'); }
      finally { clearTimeout(timer); res.off('close', abort); pending = false; }
    });
  } };
}
