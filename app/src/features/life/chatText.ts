import { esc } from '../../core/esc';

// 只生成固定标签，所有远端文字先转义；不解析 HTML、链接或图片。
function inline(text: string): string {
  return text.split(/(`[^`\n]+`)/g).map(part => part.startsWith('`') && part.endsWith('`')
    ? `<code>${esc(part.slice(1, -1))}</code>`
    : esc(part).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')).join('');
}

// 表格只把代码跨度外、未转义的竖线当分隔符。
function cells(line: string): string[] {
  const parts: string[] = [];
  let cell = '', ticks = 0;
  const source = line.trim();
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\' && source[i + 1] === '|') { cell += '|'; i++; continue; }
    if (source[i] === '`') {
      let count = 1;
      while (source[i + count] === '`') count++;
      ticks = ticks === count ? 0 : ticks || count;
      cell += '`'.repeat(count); i += count - 1; continue;
    }
    if (source[i] === '|' && !ticks) { parts.push(cell.trim()); cell = ''; }
    else cell += source[i];
  }
  parts.push(cell.trim());
  if (source.startsWith('|')) parts.shift();
  if (source.endsWith('|') && parts.at(-1) === '') parts.pop();
  return parts;
}

const rule = (line: string) => /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
const listItem = (line: string) => /^( *)(\d+[.)]|[-*+])\s+(.+)$/.exec(line);

/** 安全的聊天排版子集；未闭合代码块也可随流式输出逐步展示。 */
export function renderChatText(text: string, depth = 0): string {
  // 防止模型返回极深嵌套造成堆栈溢出，回退到转义后的纯文本。
  if (depth > 24) return `<p>${esc(text)}</p>`;
  const lines = text.replace(/\r\n?/g, '\n').replace(/^\t+/gm, tabs => '    '.repeat(tabs.length)).split('\n');
  const blocks: string[] = [];
  const tableAt = (index: number) => {
    if (!lines[index]?.includes('|') || !lines[index + 1]) return false;
    const header = cells(lines[index]), separators = cells(lines[index + 1]);
    return header.length > 1 && header.length === separators.length && separators.every(cell => /^:?-{3,}:?$/.test(cell));
  };
  const startsBlock = (index: number) => /^(?:```|#{1,6}\s|>\s?)/.test(lines[index]) || !!listItem(lines[index]) || rule(lines[index]) || tableAt(index);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue;
    }
    if (tableAt(i)) {
      const header = cells(line), separators = cells(lines[i + 1]);
      const alignment = separators.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');
      const row = (values: string[], tag: 'td' | 'th') => `<tr>${header.map((_, col) => `<${tag}${tag === 'th' ? ' scope="col"' : ''}${alignment[col] ? ` class="align-${alignment[col]}"` : ''}>${inline(values[col] ?? '')}</${tag}>`).join('')}</tr>`;
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !startsBlock(i)) rows.push(row(cells(lines[i++]), 'td'));
      blocks.push(`<div class="chat-table-scroll" role="region" aria-label="表格，可横向滚动查看" tabindex="0"><table><thead>${row(header, 'th')}</thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    if (rule(line)) { blocks.push('<hr>'); i++; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 4);
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`); i++; continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(inline(lines[i++].replace(/^>\s?/, '')));
      blocks.push(`<blockquote>${quote.join('<br>')}</blockquote>`); continue;
    }
    const firstItem = listItem(line);
    if (firstItem) {
      const indent = firstItem[1].length, ordered = /^\d/.test(firstItem[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const item = listItem(lines[i]);
        if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered || rule(lines[i])) break;
        const contentIndent = lines[i].length - item[3].length;
        const content = [item[3]];
        i++;
        while (i < lines.length) {
          if (!lines[i].trim()) {
            let next = i + 1;
            while (next < lines.length && !lines[next].trim()) next++;
            if (next >= lines.length || (lines[next].search(/\S/) <= indent && !listItem(lines[next]))) break;
            content.push(''); i++; continue;
          }
          const spaces = lines[i].search(/\S/);
          if (spaces <= indent) break;
          content.push(lines[i++].slice(Math.min(spaces, contentIndent)));
        }
        const rendered = renderChatText(content.join('\n'), depth + 1).replace(/^<p>([\s\S]*?)<\/p>/, '$1');
        items.push(`<li>${rendered}</li>`);
      }
      blocks.push(ordered ? `<ol start="${parseInt(firstItem[2], 10) || 1}">${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`); continue;
    }
    const paragraph = [inline(lines[i++])];
    while (i < lines.length && lines[i].trim() && !startsBlock(i)) paragraph.push(inline(lines[i++]));
    blocks.push(`<p>${paragraph.join('<br>')}</p>`);
  }
  return blocks.join('');
}
