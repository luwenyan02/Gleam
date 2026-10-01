import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../src/core/db';
import { listLifeChatSessions, putLifeDraft } from '../src/core/repo/lifeDraftRepo';
import { recentChatContext } from '../src/core/lifeChatContext';
import { renderChatText } from '../src/features/life/chatText';
import { formatChatReplyTime } from '../src/features/life/chatReplyTime';

it('回复时间使用本地时区显示时分，缺少或非法数据不伪造时间', () => {
  expect(formatChatReplyTime(new Date(2026, 8, 30, 14, 32).getTime())).toBe('14:32');
  expect(formatChatReplyTime(new Date(2026, 8, 30, 0, 5).getTime())).toBe('00:05');
  for (const value of [undefined, -1, NaN, Infinity, 1e20]) expect(formatChatReplyTime(value)).toBe('');
});

beforeEach(async () => { await db.delete(); await db.open(); });

it('会话列表隔离快速记录草稿，保留不同聊天并按更新时间排列', async () => {
  for (const [key, time] of [['chat:new', 1], ['chat:session:second', 3], ['new', 5]] as const) {
    await putLifeDraft({ key, title: '', body: '', occurredAt: time, chatUpdatedAt: time,
      photos: [], existingPhotoRefs: [], aiExcluded: false, messages: [{ role: 'user', content: key }] });
  }
  expect((await listLifeChatSessions()).map(row => row.key)).toEqual(['chat:session:second', 'chat:new']);
});

it('长对话只发送最近的上下文，不修改本地完整消息', () => {
  const messages = Array.from({ length: 70 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `消息${index}` }));
  const context = recentChatContext(messages);
  expect(context.length).toBeLessThanOrEqual(30);
  expect(context[0].role).toBe('user');
  expect(context.at(-1)?.content).toBe('消息69');
  expect(messages).toHaveLength(70);
  expect(recentChatContext([{ role: 'user', content: '字'.repeat(30000) }])).toHaveLength(0);
});

it('聊天排版支持代码与强调，但不能注入 HTML 或脚本链接', () => {
  const html = renderChatText('**重点**\n<script>alert(1)</script>\n```js\nconst a = 1;\n```');
  expect(html).toContain('<strong>重点</strong>');
  expect(html).toContain('<pre><code>');
  expect(html).not.toContain('<script>');
  expect(renderChatText('[点我](javascript:alert(1))')).not.toContain('href=');
});

it('长回答有段落、标题、列表与引用层级，代码不被当作 Markdown', () => {
  const html = renderChatText('先回答问题。\n\n## 核心体验\n\n1. **先聊天**\n2. 再整理\n\n> 不必每天记日记。\n> 想留再留。\n\n- 可选操作\n\n```ts\n**不是强调**\n<script>\n```');
  expect(html).toContain('<p>先回答问题。</p>');
  expect(html).toContain('<h3>核心体验</h3>');
  expect(html).toContain('<ol start="1"><li><strong>先聊天</strong></li><li>再整理</li></ol>');
  expect(html).toContain('<blockquote>不必每天记日记。<br>想留再留。</blockquote>');
  expect(html).toContain('<ul><li>可选操作</li></ul>');
  expect(html).toContain('<pre><code>**不是强调**\n&lt;script&gt;</code></pre>');
  expect(renderChatText('`**原样**`')).toContain('<code>**原样**</code>');
  expect(renderChatText('```ts\n未完成的代码')).toContain('<pre><code>未完成的代码</code></pre>');
});

it('表格呈现表头、对齐和单元格，转义分隔符与代码中的竖线不拆列', () => {
  const html = renderChatText('| 模块 | 说明 |\n| :--- | ---: |\n| **建模** | 多边形 |\n| 脚本 | `a|b` 与 x\\|y |');
  expect(html).toContain('<table>');
  expect(html).toContain('<th scope="col" class="align-left">模块</th>');
  expect(html).toContain('<td class="align-right"><code>a|b</code> 与 x|y</td>');
  expect(html).toContain('<strong>建模</strong>');
  expect(html).toContain('tabindex="0"');
  expect(renderChatText('A | B\n--- | ---\n1 | 2')).toContain('<table>');
  expect(renderChatText('A | B\n--- |')).not.toContain('<table>');
});

it('嵌套列表、连续编号与分隔线不会变成原始符号', () => {
  const html = renderChatText('4. **局限**\n\n   - 动画\n   - 特效\n     - 复杂场景\n\n5. 稳定性\n6. 支持\n\n---\n\n## 对比');
  expect(html).toContain('<ol start="4">');
  expect(html).toContain('<li><strong>局限</strong><ul>');
  expect(html).toContain('<li>特效<ul><li>复杂场景</li></ul></li>');
  expect(html).toContain('<li>稳定性</li><li>支持</li></ol><hr>');
  expect(renderChatText('说明\n---\n后文')).toContain('<hr>');
});

it('表格不放行 HTML、链接或未闭合流式内容，也不改变代码块', () => {
  const text = '| A | B |\n| --- | --- |\n| <img src=x onerror=alert(1)> | [坏链接](javascript:alert(1)) |';
  for (let end = 0; end <= text.length; end++) {
    const html = renderChatText(text.slice(0, end));
    expect(html).not.toMatch(/<img|onerror="|href=/);
  }
  expect(renderChatText('```\n| A | B |\n| --- | --- |\n---\n```')).not.toContain('<table>');
  expect(renderChatText('| A | B |\n| --- | --- |\n| 1 |')).toContain('<td>1</td><td></td>');
});
