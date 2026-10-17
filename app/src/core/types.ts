/**
 * 拾光 · 数据层类型定义
 * 依据 PRD 第五节数据模型。所有金额以「分」（整数）存储；
 * 所有实体带 createdAt/updatedAt（毫秒时间戳）；
 * 账单与生活记录软删除（deletedAt 非空即回收站，30 天后物理清除）。
 */

/* ── 枚举常量 ─────────────────────── */

/** 账单类型 */
export const ENTRY_TYPES = ['expense', 'income', 'transfer', 'loan'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** 借贷小类：借入 / 借出 / 还款 / 收款 */
export const LOAN_KINDS = ['borrow', 'lend', 'repay', 'collect'] as const;
export type LoanKind = (typeof LOAN_KINDS)[number];

/** 报销状态：无 / 待报销 / 已报销 */
export const REIMBURSE_STATUSES = ['none', 'pending', 'done'] as const;
export type ReimburseStatus = (typeof REIMBURSE_STATUSES)[number];

/** 默认账户七组（与常见个人记账账户体系一致） */
export const ACCOUNT_GROUPS = [
  'cash', 'credit', 'debit', 'online', 'investment', 'receivable', 'stored', 'other',
] as const;
export type AccountGroup = (typeof ACCOUNT_GROUPS)[number];

/** 账户分组中文名 */
export const ACCOUNT_GROUP_NAMES: Record<AccountGroup, string> = {
  cash: '现金',
  credit: '信用卡',
  debit: '储蓄卡/借记卡',
  online: '网络账户',
  investment: '投资账户',
  receivable: '应收/应付',
  stored: '储值卡',
  other: '其他',
};

/** 分类归属：支出（两级）/ 收入（单级） */
export type CategoryKind = 'expense' | 'income';

/** 周期账频率 */
export const RECUR_FREQS = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type RecurFreq = (typeof RECUR_FREQS)[number];

/** 生活记录类型：日记 / 照片 / 习惯打卡 */
export const LIFE_NOTE_KINDS = ['diary', 'photo', 'habit'] as const;
export type LifeNoteKind = (typeof LIFE_NOTE_KINDS)[number];

/** 借贷小类中文名（含图标，与原型一致） */
export const LOAN_KIND_META: Record<LoanKind, { name: string; icon: string }> = {
  borrow: { name: '借入', icon: 'ic-loan-in' },
  lend: { name: '借出', icon: 'ic-loan-out' },
  repay: { name: '还款', icon: 'ic-repay' },
  collect: { name: '收款', icon: 'ic-collect' },
};

/* ── 实体 ─────────────────────────── */

/** 所有实体共有的审计字段 */
export interface Timestamps {
  /** 创建时间（毫秒时间戳） */
  createdAt: number;
  /** 最后更新时间（毫秒时间戳） */
  updatedAt: number;
}

/**
 * 账单。四种类型字段使用约定：
 * - expense/income：categoryId + accountId 必填；
 * - transfer：fromAccountId + toAccountId 必填，不计收支；
 * - loan：loanKind + fromAccountId + toAccountId 必填，其中一侧为应收应付账户，不计收支。
 */
export interface Entry extends Timestamps {
  id: number;
  type: EntryType;
  /** 金额，单位分。手工账单为正整数；sourceAdjustment 保留挖财的负数或零金额 */
  amount: number;
  /** 原样保留的挖财冲回/零额记录；无原账单编号，不虚构退款关联。 */
  sourceAdjustment?: { source: 'wacai'; rowNo: number };
  /** 发生时间，毫秒时间戳，精确到分钟 */
  occurredAt: number;
  categoryId?: number;
  accountId?: number;
  fromAccountId?: number;
  toAccountId?: number;
  /** 旧测试格式残留；新借贷不读写独立对象，只使用 from/to 账户。 */
  loanContactId?: number;
  loanKind?: LoanKind;
  merchantId?: number;
  note?: string;
  /** 报销状态，仅支出使用；默认 'none' */
  reimburseStatus: ReimburseStatus;
  /** 报销到账时间 */
  reimbursedAt?: number;
  /** 报销到账账户 */
  reimburseAccountId?: number;
  /** 报销到账金额（分），支持部分报销 */
  reimbursedAmount?: number;
  /** 退款记录标记；退款仍归属支出分类，但账户方向与普通支出相反 */
  refundFlag?: boolean;
  /** 退款关联的原支出账单 id */
  refundOfEntryId?: number;
  /** 软删除时间；非空即在回收站，索引统一存 0 表示未删除 */
  deletedAt: number;
  importBatchId?: number;
  /** 关联生成的生活随手记 id */
  lifeNoteId?: number;
  /** 对账调整前的账内余额（分）；仅「余额对账调整」流水使用 */
  reconcileBeforeBalance?: number;
  /** 对账输入的实际余额（分）；与 reconcileBeforeBalance 一起保留审计轨迹 */
  reconcileTargetBalance?: number;
}

/** 账单-标签多对多关联 */
export interface EntryTag {
  id: number;
  entryId: number;
  tagId: number;
}

/** 账单凭证关联，顺序独立于共享附件实体。 */
export interface EntryAttachment {
  id: number;
  entryId: number;
  attachmentId: number;
  sortOrder: number;
}

/** 账户。信用卡余额为负；hidden + countInNetWorth 控制净资产口径 */
export interface Account extends Timestamps {
  id: number;
  name: string;
  group: AccountGroup;
  /** 当前余额，单位分，可为负（信用卡） */
  balance: number;
  /** 信用额度，单位分；仅 credit 组使用，缺失表示尚未设置 */
  creditLimit?: number;
  note?: string;
  hidden: boolean;
  /** 是否计入净资产；与 hidden 独立，隐藏或恢复显示不得改写此值 */
  countInNetWorth: boolean;
  /** 信用卡账单日（1-31），仅 credit 组使用 */
  billingDay?: number;
  /** 信用卡到期还款日（1-31），仅 credit 组使用 */
  repayDay?: number;
  /** 是否提示未还清账单；缺失按开启兼容旧账户 */
  creditReminderEnabled?: boolean;
  sortOrder: number;
}

/** 手工核对的信用卡账单周期。金额均以整数分存储。 */
export interface CreditStatement extends Timestamps {
  id: number;
  accountId: number;
  /** 账单周期起止（含），本地自然日时间戳 */
  periodStart: number;
  periodEnd: number;
  /** 到期还款日本地时间戳 */
  dueAt: number;
  /** 本期实际应还（分），由用户按银行账单核对 */
  amountDue: number;
  note?: string;
  /** 本期提醒开关；账户级开关关闭时本字段不再单独生效 */
  reminderEnabled: boolean;
}

/** 信用卡账单与真实转账流水的分配关系；同一流水只允许关联一次。 */
export interface CreditPayment extends Timestamps {
  id: number;
  statementId: number;
  entryId: number;
  /** 创建关联时分配给本期的金额（分）；实际已还按当前有效流水动态截断 */
  allocatedAmount: number;
}

/** 分类。支出两级（parentId 指向大类，undefined 即大类）；收入单级 */
export interface Category extends Timestamps {
  id: number;
  name: string;
  /** 图标 id，如 'ic-bowl' */
  icon: string;
  kind: CategoryKind;
  /** 支出小类指向大类 id；大类与收入分类为 undefined */
  parentId?: number;
  sortOrder: number;
}

/** 旧测试表类型，仅供原数据库/备份读取；不再参与业务或余额计算。 */
export interface LoanContact extends Timestamps {
  id: number;
  name: string;
  balance: number;
}

/** 月总预算。month 形如 '2026-08' */
export interface Budget extends Timestamps {
  id: number;
  month: string;
  /** 总额度，单位分 */
  totalLimit: number;
  /** 下月是否自动按本额度延续 */
  autoRenew: boolean;
}

/** 分类子预算（按支出大类） */
export interface CategoryBudget extends Timestamps {
  id: number;
  month: string;
  /** 支出大类 id */
  categoryId: number;
  /** 额度，单位分 */
  limit: number;
}

/** 周期账规则 */
export interface RecurringRule extends Timestamps {
  id: number;
  name: string;
  /** 收支类型；旧规则缺失时按支出兼容 */
  type?: CategoryKind;
  /** 约定金额，单位分 */
  amount: number;
  /** 「约定金额、入账时确认」模式（如水电燃气按抄表确认） */
  amountConfirm: boolean;
  freq: RecurFreq;
  /** 入账日（daily 忽略；weekly 为 0-6 周日起；monthly 为 1-31；yearly 为 MMDD 数值） */
  days: number[];
  accountId: number;
  categoryId: number;
  enabled: boolean;
  /** 下次入账时间（毫秒时间戳），由调度器推进 */
  nextRunAt: number;
  /** 每 N 个周期执行一次（周/月/年；缺省 1） */
  interval?: number;
  /** 生效开始时间（含）；早于该时间的期次不生成 */
  startDate?: number;
  /** 生效结束时间（含）；晚于该时间不再生成新期次 */
  endDate?: number;
  /** 周期转账目标账户；设置后生成 accountId → 该账户的转账流水 */
  transferToAccountId?: number;
}

/** 速记模板：分类 + 金额 + 名称 */
export interface QuickTemplate extends Timestamps {
  id: number;
  name: string;
  /** 金额，单位分 */
  amount: number;
  categoryId: number;
  /** 缺省时沿用记账默认账户，兼容旧模板。 */
  accountId?: number;
  sortOrder: number;
}

/** 标签 */
export interface Tag extends Timestamps {
  id: number;
  name: string;
  /** 标签识别色（#RRGGBB）；缺省时使用主题强调色。 */
  color?: string;
}

/** 商家，按 useCount 排序 */
export interface Merchant extends Timestamps {
  id: number;
  name: string;
  useCount: number;
}

/** 生活记录（日记 / 照片 / 打卡）。照片存 attachments 表，photoRefs 存附件 id */
export interface LifeNote extends Timestamps {
  id: number;
  kind: LifeNoteKind;
  title?: string;
  body?: string;
  /** 心情标签（日记） */
  mood?: string;
  /** 自定义标签 */
  tags?: string[];
  /** 附件 id 列表（照片记录） */
  photoRefs?: number[];
  /** 关联当日支出金额，单位分（日记可选） */
  linkedAmount?: number;
  /** 打卡关联的习惯 id */
  habitId?: number;
  occurredAt: number;
  /** 软删除时间，0 表示未删除 */
  deletedAt: number;
  /** 明确排除于生活 AI 与周刊素材之外。 */
  aiExcluded?: boolean;
  /** 采用 AI 整理正文时，与整理稿配对保存的完整用户原话。 */
  originalBody?: string;
  /** 用户确认保存记录时，一并留在本机的原始人机对话。 */
  conversation?: LifeChatMessage[];
  /** 对这段经历的轻量回看。 */
  review?: LifeReview;
}

export interface LifeReview {
  verdict?: 'again' | 'neutral' | 'not-for-me';
  text?: string;
  revisitAt?: number;
  dismissedAt?: number;
}

export interface LifeChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 含已确认账本分析；后续携带此会话文字时必须再次展示并确认。不是授权凭据。 */
  ledgerAnalysis?: boolean;
  /** AI 回复完成的时间点；旧消息和语音转写可缺省。 */
  repliedAt?: number;
  /** 草稿中用户明确随本轮发送的本地照片；不会随之后的纯文字请求再次上传。 */
  photos?: LifeDraftPhoto[];
  /** 正式记录中该轮照片的本地附件引用，避免在会话里重复保存 base64。 */
  photoRefs?: number[];
}

export interface LifeSummaryProposal {
  title: string;
  body: string;
  mood?: string;
  tags: string[];
  sourceMessageCount: number;
}

export interface LifeDraftPhoto {
  name: string;
  /** 本地原图 data URL；只有 UI 明确勾选后才可传给 AI。 */
  dataUrl: string;
}

/** 本地编辑草稿；照片原图内联以便 JSON 备份，不代表已授权上传。 */
export interface LifeDraft {
  key: string;
  chatUpdatedAt?: number;
  sourceUpdatedAt?: number;
  title: string;
  body: string;
  occurredAt: number;
  noteId?: number;
  entryId?: number;
  existingPhotoRefs: number[];
  photos: LifeDraftPhoto[];
  messages: LifeChatMessage[];
  /** AI 生成但尚未确认为正式记录的独立摘要方案。 */
  summaryProposal?: LifeSummaryProposal;
  aiText?: string;
  pendingReply?: string;
  aiExcluded: boolean;
  mood?: string;
  tags?: string[];
  review?: LifeReview;
  /** 编辑既有 AI 整理稿时用于保留原始文本，保存时仍以当前 body/messages 为准。 */
  originalBody?: string;
  /** 旧版迁移主动插入的正文消息；仅用于合并时消除已有会话中的重复项。 */
  migratedBodyMessage?: string;
}

export interface LifeEditionBlock {
  noteId: number;
  text: string;
}

export interface LifeEditionSourceRef {
  noteId: number;
  updatedAt: number;
}

/** 周刊只保存文本与来源快照；封面引用共享附件，不复制 Blob。 */
export interface LifeEdition extends Timestamps {
  id?: number;
  weekKey: string;
  title: string;
  blocks: LifeEditionBlock[];
  sourceRefs: LifeEditionSourceRef[];
  coverAttachmentId?: number;
}

/** 习惯 */
export interface Habit extends Timestamps {
  id: number;
  name: string;
  sortOrder: number;
}

/** 习惯打卡记录（连续天数由查询计算） */
export interface HabitCheck extends Timestamps {
  id: number;
  habitId: number;
  /** 打卡时间（毫秒时间戳） */
  checkAt: number;
  /** 打卡自然日 'YYYY-MM-DD'，用于连续天数与查重 */
  day: string;
}

/** 备份历史 */
export interface BackupRecord extends Timestamps {
  id: number;
  fileName: string;
  /** 文件大小（字节） */
  size: number;
  provider: 'aliyun' | 'baidu' | 'local' | 'webdav' | 's3' | 'email';
  entryCount: number;
  encrypted: boolean;
  /** 仅本机副本索引；导出时去掉，文件存在独立数据库。 */
  localFileId?: string;
}

/** 导入批次（支撑导入撤销）。'ai' 为 AI 记账收件箱入账批次 */
export interface ImportBatch extends Timestamps {
  id: number;
  source: 'wacai' | 'wechat' | 'alipay' | 'ai';
  fileName: string;
  /** 分类型计数，如 { expense: 120, income: 15, transfer: 3, loan: 2, skipped: 8 } */
  counts: Record<string, number>;
  /** 导入前快照引用（备份文件名或附件 id） */
  snapshotRef?: string;
}

/** 附件（照片 Blob 入库，路径引用由各业务表持有） */
export interface Attachment extends Timestamps {
  id: number;
  /** MIME 类型，如 image/jpeg */
  mime: string;
  /** 原始文件名（可选） */
  name?: string;
  size: number;
  blob: Blob;
  /** 凭证缩略图 data URL；原图只在预览时读取。 */
  thumbnail?: string;
}

/** 设置（kv） */
export interface Setting {
  key: string;
  value: unknown;
  updatedAt: number;
}

/* ── 设置项键名与默认值 ─────────────── */

/** 所有设置项的键与默认值；settingsRepo.get 未命中时回落到这里 */
export const SETTING_DEFAULTS = {
  /** 报销统计口径：true = 报销到账记一笔「报销」收入；false = 冲抵原支出 */
  'reimburse.countAsIncome': false,
  /** 隐藏账户是否计入净资产 */
  'netWorth.includeHidden': false,
  /** 预算自动延续 */
  'budget.autoRenew': true,
  /** 财务月起始日。限制为 1–28，1 表示自然月。 */
  'accounting.monthStartDay': 1,
  /** 回收站保留天数（展示用，v1.0 固定 30） */
  'trash.retentionDays': 30,
  /** 首页模块开关 */
  'home.modules': { month: true, quick: true, rhythm: true, today: true, past: true },
  /** 记账面板最近一次选择，用于减少重复操作 */
  'entry.lastUsed': {
    expenseCategoryId: null as number | null,
    incomeCategoryId: null as number | null,
    accountId: null as number | null,
    type: null as EntryType | null,
  },
  'entry.recentTemplates': [] as number[],
  /** 旧版兼容键；不再调度自动备份或提醒。 */
  'backup.auto': 'off' as 'off' | 'daily' | 'weekly',
  /** 自动备份仅 Wi-Fi */
  'backup.wifiOnly': true,
  /** 主题模式：浅色 / 深色 / 跟随系统 */
  'theme.mode': 'system' as 'light' | 'dark' | 'system',
  /** 首次启动种子数据已写入的标记 */
  'app.seeded': false as boolean,
  /* ── [M3] 新增设置键 ── */
  /** 上次成功备份时间（毫秒时间戳，0 = 从未备份），用于状态展示 */
  'backup.lastBackupAt': 0,
  /** 应用锁 PIN（SHA-256(盐+PIN) 十六进制 + 盐），null = 未开启 */
  'security.pin': null as { hash: string; salt: string } | null,
  /** WebAuthn 平台认证器凭据（base64url 编码的 credential id），null = 未启用 */
  'security.webauthn': null as { credId: string } | null,
  /** 旧版 IndexedDB 明文凭据已迁移并清空。 */
  'security.secretsMigrated': false as boolean,
  /** 百炼短语音独立于文字 AI；Key 只在 Android 原生安全存储，不进此设置表。 */
  'voice.bailian.region': 'beijing' as 'beijing' | 'singapore',
  'voice.bailian.workspace': '',
  'voice.bailian.model': 'qwen3.8-omni-flash-realtime' as const,
  /** 周期账 amountConfirm 待确认项持久化（刷新不丢失，确认/入账后移除） */
  'recurring.pendingConfirms': [] as {
    ruleId: number; name: string; type?: CategoryKind; amount: number; dueAt: number; accountId: number; categoryId: number;
  }[],
  /* ── [AI] 记账收件箱设置键 ── */
  /** OpenAI 兼容 API 根地址（如 https://api.openai.com 或 https://xx.com/v1） */
  'ai.baseUrl': '' as string,
  /** 图片／文本模型名，必须与平台的调用 ID 一致。 */
  'ai.model': '' as string,
  /** 旧版迁移占位；正式 API Key 由 SecretStore 保存。 */
  'ai.apiKey': '' as string,
  /** 静默入账置信度阈值（0-100）；有效置信度 ≥ 阈值且分类/账户映射成功时自动入账 */
  'ai.autoConfirmThreshold': 80,
  /** 旧版无来源的模型列表，保留兼容但不再用于选择器。 */
  'ai.recentModels': [] as string[],
  /** 带接口来源的模型缓存；旧版无来源 recentModels 仅保留兼容，不混入其他平台。 */
  'ai.modelCatalogCache': null as { baseUrl: string; ids: string[] } | null,
  /** AI 收件箱待确认队列持久化（与 recurring.pendingConfirms 同模式，确认/忽略后移除） */
  'ai.pendingItems': [] as AiPendingItem[],
  /** 生活 AI 必须由用户在本机显式开启；备份恢复不会继承开启状态。 */
  'life.aiEnabled': false as boolean,
  /* ── [R06] 云备份设置键 ── */
  /** Android QQ 邮箱配置；SMTP 授权码仅存 SecretStore。 */
  'cloud.email': { username: '', recipient: '' } as { username: string; recipient: string },
  /** 云备份通道：无 / WebDAV / S3 兼容对象存储 / Android QQ 邮箱 */
  'cloud.provider': 'none' as 'none' | 'webdav' | 's3' | 'email',
  /** WebDAV 非敏感配置；password 字段仅作旧版迁移占位。 */
  'cloud.webdav': { server: '', username: '', password: '', path: '拾光备份' } as {
    server: string; username: string; password: string; path: string;
  },
  /** S3 非敏感配置；accessKey/secretKey 字段仅作旧版迁移占位。 */
  'cloud.s3': { endpoint: '', region: '', bucket: '', accessKey: '', secretKey: '', prefix: 'gleam-backup/' } as {
    endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix: string;
  },
  /* ── [搜索] 搜索历史 ── */
  /** 搜索历史关键词数组，最多保留 10 个 */
  'search.history': [] as string[],

  /* ── [R07] 通知设置键（仅 Android 生效，默认关闭、显式开启时触发系统授权） ── */
  /** 周期账入账提醒（当日 09:00） */
  'notification.recurring': false as boolean,
  /** 信用卡还款日提醒（还款日当天 10:00） */
  'notification.creditCard': false as boolean,
  /** 旧版兼容键；备份提醒已移除，不再读取或调度。 */
  'notification.backup': false as boolean,
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/* ── [AI] 记账收件箱 ─────────────── */

/** AI 收件箱条目状态：待识别 / 识别中 / 待确认 / 识别失败 */
export const AI_ITEM_STATUSES = ['pending', 'recognizing', 'ready', 'failed'] as const;
export type AiItemStatus = (typeof AI_ITEM_STATUSES)[number];

/** AI 素材来源：系统分享 / 粘贴 / 选图 / 短语音（始终人工确认）。 */
export const AI_ITEM_SOURCES = ['share', 'paste', 'pick', 'voice'] as const;
export type AiItemSource = (typeof AI_ITEM_SOURCES)[number];

/**
 * AI 收件箱待确认条目（存 settings 'ai.pendingItems' KV，零 Dexie 迁移）。
 * 识别前仅有 rawText/attachmentId 素材；识别完成后填充账单字段与置信度。
 * 多笔识别结果拆为多条 item，可共享同一 attachmentId（最后一条移除时清理附件）。
 */
export interface AiPendingItem {
  /** 队列内唯一 id（crypto.randomUUID） */
  tempId: string;
  status: AiItemStatus;
  source: AiItemSource;
  /** 账单类型（一期仅支出/收入；接口无 from/to 账户字段，暂不承载转账/借贷） */
  type?: 'expense' | 'income';
  /** 金额，单位分 */
  amount?: number;
  /** 识别出的分类名（入账时映射为 categoryId，两级形如「餐饮/午餐」） */
  categoryName?: string;
  /** 识别出的账户名（入账时映射为 accountId） */
  accountName?: string;
  merchantName?: string;
  note?: string;
  /** 发生时间（毫秒时间戳） */
  occurredAt?: number;
  /** 有效置信度 0-100 = min(模型自报, 校验分) */
  confidence?: number;
  /** 截图素材附件 id（attachments 表） */
  attachmentId?: number;
  /** 文本素材（短信/通知原文） */
  rawText?: string;
  /** 识别失败原因 */
  error?: string;
  createdAt: number;
}
