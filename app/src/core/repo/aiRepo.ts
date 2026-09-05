/**
 * 拾光 · AI 记账仓库（aiRepo）
 * AI 记账收件箱的数据层：OpenAI 兼容 Vision/文本识别、待确认队列（settings KV）、
 * 截图附件与 AI 入账批次查询。零 Dexie 迁移——队列存 'ai.pendingItems'，
 * 来源标记复用 Entry.importBatchId → ImportBatch{source:'ai'}。
 *
 * 置信度约定：有效置信度 = min(模型自报, 校验分)。分类/账户名未匹配到现有数据、
 * 金额 ≤0、日期非法均把校验分压到阈值之下，强制进待确认（不静默入账）。
 */
import { db, now, stamp } from '../db';
import { parseYuanToFen } from '../money';
import type { Account, AiPendingItem, Attachment, Category, ImportBatch } from '../types';
import { getSetting, setSetting } from './settingsRepo';
import { listCategories } from './categoryRepo';
import { listAccounts } from './accountRepo';
import { secretStore } from '../secretStore';

/* ── 识别结果与错误 ─────────────────── */

/** 单笔识别结果（金额已转分，occurredAt 已解析为时间戳，confidence 为有效置信度） */
export interface AiParsedBill {
  type: 'expense' | 'income';
  amount: number;
  categoryName?: string;
  accountName?: string;
  merchantName?: string;
  note?: string;
  occurredAt: number;
  confidence: number;
}

/** API 未配置（baseUrl/model/apiKey 任一缺失）专用错误，UI 捕获后引导去设置页 */
export class AiConfigError extends Error {
  constructor() {
    super('尚未配置 AI 接口，请到「设置 → AI 记账」填写 API 地址与 Key');
    this.name = 'AiConfigError';
  }
}

/** 未匹配分类/账户等校验失败时压到的校验分（低于默认阈值 80，强制待确认） */
const CHECK_FAIL_SCORE = 40;
/** 正则兜底提取的置信度 */
const FALLBACK_CONFIDENCE = 20;
/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 30_000;
/** 图片压缩长边上限（像素） */
const IMAGE_MAX_EDGE = 1024;

/* ── OpenAI 兼容调用 ─────────────────── */

/**
 * 拼接 chat/completions 端点：用户 baseUrl 已含 /v1（或直接给到端点）时不重复拼接。
 */
function chatEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+[a-z]*$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * 拼接 /models 端点：与 chatEndpoint 同一套三形态规则，仅末端换成 models。
 * 已给到 chat/completions 端点 → 替换为 /models；以 /v数字 结尾 → 补 /models；
 * 裸域名 → 补 /v1/models。
 */
function modelsEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base.replace(/\/chat\/completions$/, '/models');
  if (/\/v\d+[a-z]*$/i.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}

/** 读取 AI 配置；未配置抛 AiConfigError */
async function loadConfig(): Promise<{ baseUrl: string; model: string; apiKey: string }> {
  const [baseUrl, model, apiKey] = await Promise.all([
    getSetting('ai.baseUrl'), getSetting('ai.model'), secretStore.get('ai.apiKey'),
  ]);
  if (!baseUrl.trim() || !model.trim() || !apiKey?.trim()) throw new AiConfigError();
  return { baseUrl, model, apiKey };
}

/**
 * 发起一次 chat/completions 请求（temperature 0，30s 超时），返回首条回复文本。
 * 消息体为严格 OpenAI 兼容格式；不同厂商差异后续在此函数内做 adapter。
 */
async function callChat(messages: unknown[]): Promise<string> {
  const { baseUrl, model, apiKey } = await loadConfig();
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(chatEndpoint(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0, messages }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // 响应体可能含请求回显等敏感细节：只截断打日志，不进入 UI 与持久化的 error 字段
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      if (detail) console.warn(`AI 接口 ${res.status} 响应详情：${detail}`);
      if (res.status === 401) throw new Error('AI 接口认证失败（请检查 API Key）');
      if (res.status === 429) throw new Error('AI 接口限流，请稍后重试');
      throw new Error(`AI 接口返回状态码 ${res.status}`);
    }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('AI 接口未返回内容');
    return content;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error('AI 请求超时（30 秒）');
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 测试连接：发一次最小请求验证 baseUrl/model/apiKey 可用，失败抛错。
 */
export async function testAiConnection(): Promise<void> {
  await callChat([{ role: 'user', content: '只回复两个字符：OK' }]);
}

/* ── 模型列表拉取（设置页「获取模型列表」） ── */

/** 非对话/非视觉类模型排除正则（embedding/重排/语音/实时/生图/生视频等） */
const MODEL_EXCLUDE_RE = /embed|rerank|tts|asr|audio|realtime|image|video|cogview|whisper|speech/i;
/** 视觉能力关键词：命中者优先排在候选前列（识别请求带 image_url，需支持图片） */
const MODEL_VISION_RE = /vl|vision|omni|4o|v-/i;
/** 拉取后保留的模型数上限 */
const MODELS_LIMIT = 10;

/**
 * 拉取平台 /models 模型列表：GET + Bearer Key，30s 超时；
 * 过滤非视觉/对话模型后按「静态预设命中 → 视觉关键词 → 其余」排序，去重截取 10 个，
 * 结果持久化到 'ai.recentModels'（与旧值合并、新的在前）。
 * @param preferred 静态预设清单（UI 传入，命中者排序最前）；aiRepo 不反向依赖 features 层
 * @throws 未配置地址/Key、Key 无效（401/403）、平台不支持拉取或网络失败的引导文案
 */
export async function listAiModels(preferred: string[] = []): Promise<string[]> {
  const [baseUrl, apiKey] = await Promise.all([getSetting('ai.baseUrl'), secretStore.get('ai.apiKey')]);
  if (!baseUrl.trim() || !apiKey?.trim()) throw new Error('请先填写 API 地址与 API Key');

  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  let ids: string[];
  try {
    const res = await fetch(modelsEndpoint(baseUrl), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('API Key 无效或无权限，请检查后重试');
      throw new Error('该平台可能不支持拉取模型列表，请手动填写模型名');
    }
    const data = await res.json() as { data?: { id?: unknown }[] };
    ids = (data.data ?? [])
      .map((m) => (typeof m?.id === 'string' ? m.id.trim() : ''))
      .filter(Boolean);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error('获取模型列表超时（30 秒）');
    if (err instanceof TypeError) throw new Error('网络请求失败，请检查 API 地址；也可手动填写模型名');
    throw err;
  } finally {
    window.clearTimeout(timer);
  }

  const pref = new Set(preferred.map((m) => m.toLowerCase()));
  const rank = (id: string): number => {
    if (pref.has(id.toLowerCase())) return 0;
    if (MODEL_VISION_RE.test(id)) return 1;
    return 2;
  };
  const top = [...new Set(ids.filter((id) => !MODEL_EXCLUDE_RE.test(id)))]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, MODELS_LIMIT);

  // 旧值行可能 value=null（外部写入/异常旧值，getSetting 原样返回）：合并前兑底，避免 [...null] 抛错
  const prev = (await getSetting('ai.recentModels')) ?? [];
  await setSetting('ai.recentModels', [...new Set([...top, ...prev])].slice(0, MODELS_LIMIT));
  return top;
}

/* ── Prompt 工程 ─────────────────────── */

/** 拼接当前分类树（支出「大类/小类」+ 收入单级）与账户名候选集的 system prompt */
async function buildSystemPrompt(): Promise<string> {
  const [expenseCats, incomeCats, accounts] = await Promise.all([
    listCategories('expense'), listCategories('income'), listAccounts(),
  ]);
  const expenseNames: string[] = [];
  for (const parent of expenseCats.filter((c) => c.parentId == null)) {
    const children = expenseCats.filter((c) => c.parentId === parent.id);
    if (children.length) for (const c of children) expenseNames.push(`${parent.name}/${c.name}`);
    else expenseNames.push(parent.name);
  }
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return [
    '你是记账助手。从用户提供的支付截图、短信或扣款通知文本中提取账单，输出严格 JSON 数组（不要 markdown 代码块、不要任何解释文字）。',
    '每笔账单一个对象，字段：',
    '{"type":"expense"或"income","amount":金额数字(单位元),"category":"分类名","account":"账户名","merchant":"商家名(没有则空串)","time":"YYYY-MM-DD HH:mm","note":"简短备注(没有则空串)","confidence":0到100的整数置信度}',
    '规则：',
    '- category 必须从下方候选分类中原样选择（支出用「大类/小类」全名）；实在无法归类时填空串',
    '- account 必须从下方候选账户中原样选择；无法判断时填空串',
    '- time 解析不出具体时刻时用当天 12:00；"昨天/今天"等相对时间按下方今天日期换算',
    '- 内容里没有账单时输出 []；一张截图多笔账单则逐笔输出',
    `候选支出分类：${expenseNames.join('、') || '（无）'}`,
    `候选收入分类：${incomeCats.map((c) => c.name).join('、') || '（无）'}`,
    `候选账户：${accounts.map((a) => a.name).join('、') || '（无）'}`,
    `今天是 ${today}`,
  ].join('\n');
}

/* ── 分类 / 账户名映射（识别校验与入账共用） ── */

/**
 * 分类名 → id：两级键「大类/小类」先精确配对，退化配同名小类；
 * 单级名先小类再大类（与 import.ts 匹配思路一致）。
 */
export function mapCategoryNameToId(
  kind: 'expense' | 'income',
  name: string,
  expenseCats: Category[],
  incomeCats: Category[],
): number | undefined {
  const n = name.trim();
  if (!n) return undefined;
  if (kind === 'income') return incomeCats.find((c) => c.name === n)?.id;
  if (n.includes('/')) {
    const [big, small] = n.split('/', 2).map((s) => s.trim());
    const bigCat = expenseCats.find((c) => c.parentId == null && c.name === big);
    if (bigCat) {
      const child = expenseCats.find((c) => c.parentId === bigCat.id && c.name === small);
      if (child) return child.id;
    }
    return expenseCats.find((c) => c.parentId != null && c.name === small)?.id;
  }
  return (
    expenseCats.find((c) => c.parentId != null && c.name === n)?.id
    ?? expenseCats.find((c) => c.parentId == null && c.name === n)?.id
  );
}

/** 账户名 → id：先全等，再互相包含（截图中账户名常带尾号等噪声） */
export function mapAccountNameToId(name: string, accounts: Account[]): number | undefined {
  const n = name.trim();
  if (!n) return undefined;
  const exact = accounts.find((a) => a.name === n);
  if (exact) return exact.id;
  return accounts.find((a) => n.includes(a.name) || a.name.includes(n))?.id;
}

/* ── 模型输出解析 ─────────────────────── */

/** 解析模型回复的时间字符串；非法返回 undefined */
function parseBillTime(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const s = raw.trim()
    .replace(/[年月/]/g, '-').replace(/日/g, '')
    .replace('T', ' ');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/.exec(s);
  if (!m) return undefined;
  const ts = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    m[4] != null ? Number(m[4]) : 12, m[5] != null ? Number(m[5]) : 0,
  ).getTime();
  // 合理性窗口：2000 年至未来一天，超出视作日期非法
  if (!Number.isFinite(ts) || ts < new Date(2000, 0, 1).getTime() || ts > now() + 86_400_000) return undefined;
  return ts;
}

/** 元（number/字符串）→ 分；非法或超出安全整数范围返回 0 */
function yuanToFen(raw: unknown): number {
  if (typeof raw === 'string') {
    try {
      return parseYuanToFen(raw.replace(/[¥￥元\s]/g, ''));
    } catch {
      return 0;
    }
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  const fen = Math.round(raw * 100);
  return Number.isSafeInteger(fen) ? fen : 0;
}

/**
 * 把模型一笔输出规整为 AiParsedBill，并按校验结果计算有效置信度。
 */
function normalizeBill(
  raw: Record<string, unknown>,
  expenseCats: Category[],
  incomeCats: Category[],
  accounts: Account[],
): AiParsedBill {
  const type = raw.type === 'income' ? 'income' : 'expense';
  const amount = yuanToFen(raw.amount);
  const categoryName = typeof raw.category === 'string' ? raw.category.trim() : '';
  const accountName = typeof raw.account === 'string' ? raw.account.trim() : '';
  const merchantName = typeof raw.merchant === 'string' ? raw.merchant.trim() : '';
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  const time = parseBillTime(raw.time);
  const modelConf = Math.max(0, Math.min(100, Math.round(Number(raw.confidence) || 0)));

  // 校验分：金额非法归零；分类/账户/日期任一未过压到 CHECK_FAIL_SCORE
  let check = 100;
  if (amount <= 0 || !Number.isSafeInteger(amount)) check = 0;
  if (mapCategoryNameToId(type, categoryName, expenseCats, incomeCats) == null) check = Math.min(check, CHECK_FAIL_SCORE);
  if (mapAccountNameToId(accountName, accounts) == null) check = Math.min(check, CHECK_FAIL_SCORE);
  if (time == null) check = Math.min(check, CHECK_FAIL_SCORE);

  return {
    type,
    amount,
    categoryName: categoryName || undefined,
    accountName: accountName || undefined,
    merchantName: merchantName || undefined,
    note: note || undefined,
    occurredAt: time ?? now(),
    confidence: Math.min(modelConf, check),
  };
}

/**
 * 解析模型回复：严格 JSON 数组优先；失败时正则兜底提取金额/日期并置为低置信度。
 * @param sourceText 兜底备注用的原始素材文本（图片识别传空串）
 */
function parseReply(
  reply: string,
  sourceText: string,
  expenseCats: Category[],
  incomeCats: Category[],
  accounts: Account[],
): AiParsedBill[] {
  // 剥掉可能的 ```json 围栏后截取最外层数组
  const cleaned = reply.replace(/```(?:json)?/gi, '').trim();
  const jsonText = /\[[\s\S]*\]/.exec(cleaned)?.[0] ?? cleaned;
  try {
    const arr = JSON.parse(jsonText) as unknown;
    if (Array.isArray(arr)) {
      return arr
        .filter((it): it is Record<string, unknown> => typeof it === 'object' && it != null)
        .map((it) => normalizeBill(it, expenseCats, incomeCats, accounts));
    }
  } catch { /* JSON 失败走正则兜底 */ }

  const basis = `${reply}\n${sourceText}`;
  const amtMatch = /(?:¥|￥)\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*元/.exec(basis);
  const amount = amtMatch ? yuanToFen(amtMatch[1] ?? amtMatch[2]) : 0;
  if (amount <= 0) return [];
  const dateMatch = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(basis);
  const time = dateMatch ? parseBillTime(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`) : undefined;
  return [{
    type: 'expense',
    amount,
    note: sourceText.slice(0, 50) || undefined,
    occurredAt: time ?? now(),
    confidence: FALLBACK_CONFIDENCE,
  }];
}

/* ── 图片压缩 ─────────────────────────── */

/**
 * Canvas 压缩截图：长边 ≤1024px、JPEG 0.8，转 data URL 供 image_url 发送
 * （控制 token 与内存；原图 Blob 留 attachments 供收件箱预览）。
 */
async function compressImageToDataUrl(blob: Blob): Promise<string> {
  const bmp = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.8);
  } finally {
    bmp.close();
  }
}

/* ── 识别入口 ─────────────────────────── */

/**
 * 识别文本素材（短信/扣款通知/手动粘贴），返回结构化账单（支持一次多笔）。
 * @throws AiConfigError API 未配置；其他网络/解析错误按 Error 抛出
 */
export async function recognizeText(text: string): Promise<AiParsedBill[]> {
  const [system, expenseCats, incomeCats, accounts] = await Promise.all([
    buildSystemPrompt(), listCategories('expense'), listCategories('income'), listAccounts(),
  ]);
  const reply = await callChat([
    { role: 'system', content: system },
    { role: 'user', content: text },
  ]);
  return parseReply(reply, text, expenseCats, incomeCats, accounts);
}

/**
 * 识别截图素材（压缩后以 image_url data URL 发送），返回结构化账单。
 * @throws AiConfigError API 未配置；其他网络/解析错误按 Error 抛出
 */
export async function recognizeImage(blob: Blob): Promise<AiParsedBill[]> {
  const [system, dataUrl, expenseCats, incomeCats, accounts] = await Promise.all([
    buildSystemPrompt(), compressImageToDataUrl(blob),
    listCategories('expense'), listCategories('income'), listAccounts(),
  ]);
  const reply = await callChat([
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请从这张截图中提取账单：' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ]);
  return parseReply(reply, '', expenseCats, incomeCats, accounts);
}

/* ── 待确认队列（settings 'ai.pendingItems' KV） ── */

/** 队列读-改-写互斥锁，避免识别回写与用户操作并发丢更新 */
let queueLock: Promise<unknown> = Promise.resolve();

/**
 * 原子化修改队列（读-改-写，经 setSetting 广播 'settings-changed'）。
 * @param fn 收到队列副本，返回新队列
 */
async function mutateQueue(fn: (items: AiPendingItem[]) => AiPendingItem[]): Promise<AiPendingItem[]> {
  const run = queueLock.then(async () => {
    const items = await getSetting('ai.pendingItems');
    const next = fn(items.slice());
    await setSetting('ai.pendingItems', next);
    return next;
  });
  queueLock = run.catch(() => undefined);
  return run;
}

/** 读取待确认队列（新→旧排序由写入端保证，此处原样返回） */
export async function listAiPendingItems(): Promise<AiPendingItem[]> {
  return getSetting('ai.pendingItems');
}

/** 追加条目到队列头部（最新的排最前） */
export async function addAiPendingItems(items: AiPendingItem[]): Promise<void> {
  await mutateQueue((cur) => [...items, ...cur]);
}

/** 更新单条条目字段 */
export async function updateAiPendingItem(tempId: string, patch: Partial<AiPendingItem>): Promise<void> {
  await mutateQueue((cur) => cur.map((it) => (it.tempId === tempId ? { ...it, ...patch } : it)));
}

/**
 * 用识别结果替换原素材条目（一次多笔时 1 → N 展开，继承 attachmentId 等素材引用）。
 */
export async function replaceAiPendingItem(tempId: string, items: AiPendingItem[]): Promise<void> {
  await mutateQueue((cur) => {
    const idx = cur.findIndex((it) => it.tempId === tempId);
    if (idx < 0) return cur;
    cur.splice(idx, 1, ...items);
    return cur;
  });
}

/**
 * 移除条目（确认入账 / 忽略后调用），并清理不再被任何条目引用的截图附件，防止孤儿 Blob。
 */
export async function removeAiPendingItems(tempIds: string[]): Promise<void> {
  const ids = new Set(tempIds);
  let orphanAttachmentIds: number[] = [];
  await mutateQueue((cur) => {
    const removed = cur.filter((it) => ids.has(it.tempId));
    const kept = cur.filter((it) => !ids.has(it.tempId));
    const keptAtt = new Set(kept.map((it) => it.attachmentId).filter((id): id is number => id != null));
    orphanAttachmentIds = [...new Set(
      removed.map((it) => it.attachmentId).filter((id): id is number => id != null && !keptAtt.has(id)),
    )];
    return kept;
  });
  if (orphanAttachmentIds.length) await db.attachments.bulkDelete(orphanAttachmentIds);
}

/**
 * 中断恢复：把上次识别中途退出遗留的 'recognizing' 条目重置为 'pending' 供重试。
 * @returns 重置条数
 */
export async function resetStuckRecognizing(): Promise<number> {
  let count = 0;
  await mutateQueue((cur) => cur.map((it) => {
    if (it.status !== 'recognizing') return it;
    count++;
    return { ...it, status: 'pending' as const };
  }));
  return count;
}

/* ── 截图附件与 AI 批次 ─────────────────── */

/** 存入截图 Blob 到 attachments 表，返回附件 id（AiPendingItem.attachmentId 持有引用） */
export async function saveAiAttachment(blob: Blob, name?: string): Promise<number> {
  return db.attachments.add(stamp({ mime: blob.type || 'application/octet-stream', name, size: blob.size, blob }) as Attachment);
}

/** 读取截图附件（收件箱卡片预览用） */
export async function getAiAttachment(id: number): Promise<Attachment | undefined> {
  return db.attachments.get(id);
}

/** 按 id 读取入账批次（详情页「来源」区分 AI 记账 / 账单导入用） */
export async function getImportBatch(id: number): Promise<ImportBatch | undefined> {
  return db.importBatches.get(id);
}

/**
 * 最近的 AI 入账批次（source='ai'，createdAt 倒序），供「撤销本批」展示。
 * @param limit 返回条数上限，默认 3
 */
export async function listAiBatches(limit = 3): Promise<ImportBatch[]> {
  const rows = await db.importBatches.orderBy('createdAt').reverse().toArray();
  return rows.filter((b) => b.source === 'ai').slice(0, limit);
}
