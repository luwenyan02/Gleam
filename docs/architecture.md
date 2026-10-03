# 架构说明

## 展示层账务事件

`core/ledgerEvents.ts` 把原账单转换为只读展示事件。报销计收入时，到账事件保留原账单 ID，使用到账时间、到账账户和到账金额；不创建第二条数据库账单。搜索与报表汇总共享这组事件，明细点击仍定位原支出。账户现金流始终包含到账事件，不受“冲抵支出／计入收入”统计偏好影响；历史期末从当前余额减去之后的现金流倒推。

金额仍使用整数分，周期使用 `[from, to)`；展示事件不会增加第二份账务实体。

## 技术形态

拾光是无前端框架的 TypeScript 单页应用，由 Vite 构建，Dexie 管理 IndexedDB，Vite PWA 提供离线外壳，Capacitor 封装 Android 能力。

## 分层

```text
页面与交互 features/*
        ↓
领域仓库 core/repo/*
        ↓
Dexie 数据库 core/db.ts
        ↓
IndexedDB / Android WebView 存储
```

- `features/shell` 管理一级页面、子页面、抽屉、对话框和底部导航。
- `features/entry` 是记账协调层；保存行为必须进入 `entryRepo`。
- `features/search`、`features/report` 和账户详情共享同一查询条件，避免汇总与明细口径分叉。
- `features/backup` 负责本地、WebDAV 和 S3 备份；云端实现不得直接读取未授权业务状态。
- `core/secretStore.ts` 统一管理外部服务凭据：Android 委托系统 Keystore，PWA 使用会话存储。
- `core/money.ts` 是金额解析与格式化的唯一入口。

## 凭证与桌面入口

- IndexedDB v3 增加 `entryAttachments`，以唯一的 `entryId + attachmentId` 建立普通流水与现有 Blob 附件的有序关联。
- `entrySaveRepo` 将新图片、关系、账单、账户余额和可选生活记录置于同一个事务；取消时只释放内存草稿。
- 附件回收同时检查普通流水、生活记录（包括回收站）与 AI 待确认队列，防止删除共享图片。
- IndexedDB v4 增加 `lifeDrafts`（上下文 key）和 `lifeEditions`（自然周唯一 key）；附件回收也保护草稿照片与周刊封面。草稿、照片、生活记录与可选账单关系在同一事务保存。
- `lifeAiRepo` 复用私密模式的 AI 请求边界，只接收显式选择的材料，支持取消与请求前后校验；周刊解析校验来源 ID 和版本，生成与收藏分离。快速记录由 `lifeComposer` 处理且不依赖 AI；`lifeChat` 维护全屏对话，`lifeSummarySheet` 只在用户确认后调用 `lifeDraftRepo` 原子保存正式记录与会话。聊天照片在草稿中按消息内联，正式保存时转换为附件引用，后续纯文字请求不会重新上传历史照片。账单仍沿用 `Entry.lifeNoteId`，不新增余额对象。
- Android `GleamEntry` 只发布系统快捷入口及小组件衍生摘要，不持有完整账本、不直接写入账务数据。应用锁启用时小组件缓存不包含明文金额，快捷模板使用泛化名称。
- 外部入口严格解析 `shiguang://entry` 的白名单参数，解锁后才消费；已打开的草稿不被覆盖，失效模板回退普通支出。小组件缓存带周期与更新时间，周期过期后不继续显示旧金额。

## 核心不变量

- 金额以整数分存储，实体金额恒为正，方向由账单类型决定。
- 转账和借贷不计入普通收支。
- 借贷保留 `type=loan` 与 `loanKind`，余额只由 `fromAccountId/toAccountId` 双边影响决定；一侧是资金账户，另一侧是 `receivable` 应收应付账户。
- `core/entryEffects.ts` 统一账单写入、回滚和现金流计算；`core/loanLedger.ts` 定义方向和账户角色校验。应收为正、应付为负，均进入账户资产负债口径。
- 当前净资产与历史走势共用 `listNetWorthAccounts` 的账户纳入口径，不能用被排除的隐藏账户一侧抵消可见侧本金或报销事件。
- 退款反向影响账户和支出统计，并关联原支出。
- 报销到账和原支出分别建模，避免覆盖历史事实。
- 账单与生活记录先软删除，回收站到期后再物理清除。
- 备份不包含云服务与 AI 的凭据。
- 旧版明文凭据迁移后立即从 IndexedDB 清空，安全存储失败时要求用户重新输入。

## UI 状态

一级页面由 shell 保持，非活动页面必须同时设置隐藏、`aria-hidden` 和 `inert`。子页面通过路由栈保存返回位置；抽屉和对话框负责焦点锁定及焦点恢复。

## 扩展原则

新增能力优先扩展已有仓库和内部类型；只有持久化实体确实需要新增字段时才升级 Dexie schema，并同时提供迁移、回滚与备份恢复测试。

本地 v1.4.0 测试阶段经用户确认不迁移旧独立借贷对象。既有 schema 中的 `loanContacts` 仅保留为未使用的历史容器，页面、导入及新流水均不读写该表；不自动清除旧账本。新借贷复用现有双账户字段，无需新增表或 schema 升级。

## 本机可核对的账本分析

`lifeLedgerContextRepo` 在同一只读事务中构造固定 1／2／6 月聚合，复用 `ledgerEntriesInRange` 与 `summarizeLedgerEntries`。公开 review 只有问题与聚合；原始事件、分类身份及快照留在 WeakMap，grant 克隆保留私有来源验证能力。请求前后和本机下钻都复核摘要与原始快照，防止同额替换绕过过期判断。

`lifeLedgerConsent` 负责手选范围与单次发送确认，`lifeLedgerResult` 只用本机聚合渲染核对卡、限定明细选择器与两项规则追问，`lifeChat` 在请求成功后才把卡片留在当前页面内存。模型文字没有操作执行入口。没有数据库结构、账户余额、自动入账或生活记录流程变更。详见 [功能与边界](AI_LEDGER_ANALYSIS.md)。
