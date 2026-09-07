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
 * - loan：loanKind + loanContactId + accountId 必填，不计收支。
 */
export interface Entry extends Timestamps {
  id: number;
  type: EntryType;
  /** 金额，单位分，恒为正整数；方向由 type/loanKind 决定 */
  amount: number;
  /** 发生时间，毫秒时间戳，精确到分钟 */
  occurredAt: number;
  categoryId?: number;
  accountId?: number;
  fromAccountId?: number;
  toAccountId?: number;
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
}

/** 账单-标签多对多关联 */
export interface EntryTag {
  id: number;
  entryId: number;
  tagId: number;
}

/** 账户。信用卡余额为负；hidden + countInNetWorth 控制净资产口径 */
export interface Account extends Timestamps {
  id: number;
  name: string;
  group: AccountGroup;
  /** 当前余额，单位分，可为负（信用卡） */
  balance: number;
  note?: string;
  hidden: boolean;
  /** 隐藏账户是否计入净资产（跟随设置项初始化，可单独覆盖） */
  countInNetWorth: boolean;
  /** 信用卡还款日（1-31），仅 credit 组使用 */
  repayDay?: number;
  sortOrder: number;
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

/** 借贷对象。balance 正 = TA 欠你，负 = 你欠 TA，单位分 */
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
}

/** 速记模板：分类 + 金额 + 名称 */
export interface QuickTemplate extends Timestamps {
  id: number;
  name: string;
  /** 金额，单位分 */
  amount: number;
  categoryId: number;
  sortOrder: number;
}

/** 标签 */
export interface Tag extends Timestamps {
  id: number;
  name: string;
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
  provider: 'aliyun' | 'baidu' | 'local' | 'webdav' | 's3';
  entryCount: number;
  encrypted: boolean;
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
  /** 回收站保留天数（展示用，v1.0 固定 30） */
  'trash.retentionDays': 30,
  /** 首页模块开关 */
  'home.modules': { month: true, quick: true, today: true, past: true },
  /** 记账面板最近一次选择，用于减少重复操作 */
  'entry.lastUsed': {
    expenseCategoryId: null as number | null,
    incomeCategoryId: null as number | null,
    accountId: null as number | null,
    type: null as EntryType | null,
  },
  /** 自动备份：off / daily / weekly */
  'backup.auto': 'off' as 'off' | 'daily' | 'weekly',
  /** 自动备份仅 Wi-Fi */
  'backup.wifiOnly': true,
  /** 主题模式：浅色 / 深色 / 跟随系统 */
  'theme.mode': 'system' as 'light' | 'dark' | 'system',
  /** 首次启动种子数据已写入的标记 */
  'app.seeded': false as boolean,
  /* ── [M3] 新增设置键 ── */
  /** 上次成功备份时间（毫秒时间戳，0 = 从未备份），自动备份到期检测用 */
  'backup.lastBackupAt': 0,
  /** 应用锁 PIN（SHA-256(盐+PIN) 十六进制 + 盐），null = 未开启 */
  'security.pin': null as { hash: string; salt: string } | null,
  /** WebAuthn 平台认证器凭据（base64url 编码的 credential id），null = 未启用 */
  'security.webauthn': null as { credId: string } | null,
  /** 旧版 IndexedDB 明文凭据已迁移并清空。 */
  'security.secretsMigrated': false as boolean,
  /** 周期账 amountConfirm 待确认项持久化（刷新不丢失，确认/入账后移除） */
  'recurring.pendingConfirms': [] as {
    ruleId: number; name: string; amount: number; dueAt: number; accountId: number; categoryId: number;
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
  /* ── [R06] 云备份设置键 ── */
  /** 云备份通道：无 / WebDAV / S3 兼容对象存储 */
  'cloud.provider': 'none' as 'none' | 'webdav' | 's3',
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
  /** 备份到期提醒（到期次日 09:00） */
  'notification.backup': false as boolean,
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/* ── [AI] 记账收件箱 ─────────────── */

/** AI 收件箱条目状态：待识别 / 识别中 / 待确认 / 识别失败 */
export const AI_ITEM_STATUSES = ['pending', 'recognizing', 'ready', 'failed'] as const;
export type AiItemStatus = (typeof AI_ITEM_STATUSES)[number];

/** AI 素材来源：系统分享 / 收件箱粘贴文本 / 收件箱选图（二期相册、三期通知监听预留枚举位） */
export const AI_ITEM_SOURCES = ['share', 'paste', 'pick'] as const;
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
