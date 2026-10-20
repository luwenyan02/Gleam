import { expect, it, vi } from 'vitest';
import type { LifeChatMessage } from '../src/core/types';
import { needsVoiceLayout, VoiceReplyLayouts } from '../src/features/life/voiceReplyLayout';

const original = '周六上午可以去公园散步，中午在附近吃饭，下午沿河骑车。周日早上去博物馆，下午在家休息。请按自己的体力调整行程，遇到下雨时可以把户外活动换到室内。'.repeat(2);
const destination = { baseUrl: 'https://layout.invalid/v1', model: 'text-model' };
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(done => { resolve = done; });
  return { promise, resolve };
}
it('短句和已有结构无需额外请求，长的口语回复才整理', () => {
  expect(needsVoiceLayout('你好，有什么想聊的？')).toBe(false);
  expect(needsVoiceLayout(original)).toBe(true);
  expect(needsVoiceLayout(`## 周末计划\n\n- ${original}`)).toBe(false);
  expect(needsVoiceLayout(`| 日期 | 安排 |\n| --- | --- |\n| 周六 | ${original} |`)).toBe(false);
});
it('只并发一项、重复快照不重发，原话不被排版覆盖', async () => {
  const first = deferred(), second = deferred();
  const format = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const changed = vi.fn(), a: LifeChatMessage = { role: 'assistant', content: original }, b: LifeChatMessage = { role: 'assistant', content: original + '第二轮' };
  const layout = new VoiceReplyLayouts({ format, isCurrent: () => true, onChange: changed, onError: vi.fn() });
  layout.add(a, destination); layout.add(a, destination); layout.add(b, destination);
  expect(format).toHaveBeenCalledTimes(1);
  first.resolve('## 周末\n\n- 公园散步');
  await vi.waitFor(() => expect(format).toHaveBeenCalledTimes(2));
  expect(a).toEqual({ role: 'assistant', content: original, voiceDisplay: '## 周末\n\n- 公园散步' });
  layout.add(a, destination); expect(format).toHaveBeenCalledTimes(2);
  second.resolve('| 日期 | 安排 |\n| --- | --- |\n| 周日 | 休息 |');
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
});
it('原话变化、会话移除、取消和旧请求迟到时不回写；失败保留原文', async () => {
  for (const mode of ['edited', 'removed', 'cancelled', 'failed']) {
    const pending = deferred(), message: LifeChatMessage = { role: 'assistant', content: original };
    let current = true;
    const changed = vi.fn(), onError = vi.fn();
    const format = vi.fn().mockReturnValue(pending.promise);
    const layout = new VoiceReplyLayouts({ format, isCurrent: () => current, onChange: changed, onError });
    layout.add(message, destination);
    if (mode === 'edited') message.content = '新的原话';
    if (mode === 'removed') current = false;
    if (mode === 'cancelled') layout.cancel();
    pending.resolve(mode === 'failed' ? '' : '## 迟到排版');
    await new Promise(done => setTimeout(done, 0));
    expect(message.voiceDisplay).toBeUndefined(); expect(changed).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(mode === 'failed' ? 1 : 0);
    if (mode === 'cancelled') expect(format.mock.calls[0][0].signal.aborted).toBe(true);
  }
});
