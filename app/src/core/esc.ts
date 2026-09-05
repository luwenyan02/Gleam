/**
 * 拾光 · HTML 转义工具
 * 所有把用户可控文本（账户名/备注/分类名/标签名/商家名/往来人名/模板名/习惯名/
 * 日记标题正文/照片说明/备份文件名/导入单元格内容等）拼入 innerHTML 模板字符串处
 * 必须先经 esc()，防止存储型/反射型 XSS。
 */

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 转义 HTML 特殊字符（& < > " '）。null/undefined 返回空串。 */
export function esc(text: string | number | null | undefined): string {
  if (text == null) return '';
  return String(text).replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}
