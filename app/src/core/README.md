# 拾光 · 数据层 API 约定（src/core/）

供 M1-A / M1-B / M2-C / M2-D / M3 各开发代理阅读。**UI 模块一律经 `repo/` 访问数据，禁止直接操作 `db`。**

## 核心约定

| 约定 | 说明 |
|---|---|
| 金额 | 一律以「分」（正整数）存储与计算；分↔元换算**只**走 `money.ts`（`parseYuanToFen` / `formatFen` / `formatFenCny`） |
| 时间 | 毫秒时间戳；`occurredAt` 精确到分钟 |
| 主键 | Dexie `++id` 自增数字 |
| 软删除 | `entries` / `lifeNotes` 的 `deletedAt`：**0 = 未删除**（不是 undefined，为了复合索引 `[deletedAt+occurredAt]` 范围查询）；非 0 即在回收站 |
| 审计 | 所有实体 `createdAt` / `updatedAt`（`db.ts` 的 `stamp()` 补齐，更新时自带 `updatedAt: now()`） |
| 事件 | repo 写操作后自动 `emit`；UI 用 `store.on(event, cb)` 订阅刷新，返回值为取消订阅函数 |

### 事件名（store.ts）

`entries-changed` · `accounts-changed` · `categories-changed` · `budgets-changed` · `life-changed` · `settings-changed` · `route-changed`

## 数据一致性硬规则（entryRepo 事务内保证）

- 支出保存 → 账户余额 −；收入 → +；转账 → from − / to +；
- 借贷按 `loanKind`：借出 lend / 还款 repay → 资金账户 −、应收应付账户 +；借入 borrow / 收款 collect 反向。余额使用 from/to 双账户，不再使用独立对象；
- 转账 / 借贷**不计收支统计**（statsRepo 已按此口径过滤）；
- 编辑 = 回滚旧账单余额影响 + 重放新账单；软删除 = 回滚；恢复 = 重放；物理删除仅允许回收站内账单；
- 报销到账效果（`reimburseAccountId` + `reimbursedAmount`）随原账单一起回滚/重放；
- 对账不直接改余额：`accountRepo.reconcileAccount` 生成一笔 note 为「余额对账调整」的**单边转账账单**（不计收支、可追溯）。

## 报销统计口径（settings `reimburse.countAsIncome`）

- `false`（冲抵，默认）：已到账报销额按**原账单 occurredAt** 所在周期从支出扣减；
- `true`（计收入）：已到账报销额按 **reimbursedAt** 所在周期计入收入。
- `entryRepo.settleReimbursement` 只落数据（标记 done + 到账账户加钱），不生成收入账单；口径差异全部在 statsRepo 计算层处理。

## repo API 一览

### entryRepo（账单，核心）
`addEntry(input, tagIds?)` · `updateEntry(id, patch, tagIds?)` · `softDeleteEntry(id)` · `restoreEntry(id)` · `purgeEntry(id)` · `getEntry(id)` · `getEntryTagIds(entryId)` · `listEntries(filter)` · `listEntriesByDay(filter)` · `dayKey(ts)` · `listDeletedEntries()` · `findDuplicates(occurredAt, type, amount, accountId)` · `settleReimbursement(ids, reimburseAccountId, amountById?)`

### statsRepo（统计，只读）
`monthRange(month)` / `weekRange(ts)` / `yearRange(year)` · `rangeSummary(from, to)` · `monthSummary(month)` · `categoryBreakdown(from, to)`（小类聚合到大类） · `accountRanking(from, to)` · `tagRanking(from, to)` · `dailyAggregates(month)`（日历用） · `netWorthTrend(months=6)`（当前余额倒推） · `budgetUsage(month)`（与首页月度总览同源）

### accountRepo（账户）
`addAccount` · `updateAccount`（禁止直接改 balance） · `deleteAccount`（有关联账单抛错） · `setAccountHidden` · `reconcileAccount(id, targetBalance)` · `getAccount` · `listAccounts(includeHidden?)` · `listAccountsByGroup()` · `getNetWorth()`（hidden 且 countInNetWorth=false 不计入）

### categoryRepo（分类）
`addCategory` · `updateCategory` · `moveCategory` · `deleteCategory(id, transferToId?)`（有账单引用必须转移） · `getCategory` · `listCategories(kind)` · `listExpenseTree()`

### tagRepo / merchantRepo / loanRepo
`listTags` · `ensureTag(name)` · `renameTag` · `deleteTag`（连带清 entryTags）
`listMerchants`（useCount 降序） · `ensureMerchant` · `touchMerchant` · `deleteMerchant`
`listLoanAccounts` · `getLoanAccount` · `ensureLoanAccount` · `renameLoanAccount` · `deleteLoanAccount` · `listLoanAccountEntries`（均操作 accounts 中的应收应付分组，不操作旧对象表）

### budgetRepo / recurringRepo / templateRepo
`getBudget(month)` · `setBudget` · `ensureMonthBudget(month)`（按上月 autoRenew 延续） · `listCategoryBudgets` · `setCategoryBudget`
`addRule` · `updateRule` · `setRuleEnabled` · `deleteRule` · `listRules` · `ruleSummary` · `computeNextRunAt` · `runDueRules(asOf?)`（amountConfirm 规则返回 PendingConfirm 不入账）
`addTemplate` · `updateTemplate` · `deleteTemplate` · `listTemplates`

### lifeRepo（生活记录 / 习惯）
`addLifeNote` · `updateLifeNote` · `softDeleteLifeNote` · `restoreLifeNote` · `purgeLifeNote` · `getLifeNote` · `listLifeNotes({from?, to?, kind?})` · `listDeletedLifeNotes` · `addAttachment(blob)` · `getAttachment` · `addHabit` · `renameHabit` · `deleteHabit` · `listHabits` · `checkHabit`（同日幂等） · `uncheckHabit` · `isCheckedToday` · `habitStreak`

### trashRepo（回收站）
`listTrash()`（账单+生活记录统一视图） · `restoreTrashItem` · `purgeTrashItem` · `emptyTrash` · `purgeExpired()`（超 30 天，scheduler 调用）

### settingsRepo
`getSetting(key)`（未写入回落 `SETTING_DEFAULTS`） · `setSetting(key, value)` · `getAllSettings()`。键名见 `types.ts` SETTING_DEFAULTS。

### seed / scheduler
`seedIfNeeded()`（幂等，`app.seeded` 标记）；`startScheduler()` / `catchUp()`（周期账补跑 + 回收站清理 + 自动备份提醒预留）、`onPendingConfirm(cb)`（周期账待确认通知，M2 注册）。

## 外壳接口（src/features/shell/）

- `registerPage(id, { render(el), onShow? })`：一级页（`page-home` / `page-acct` / `page-report` / `page-life` / `page-mine`），可重复注册覆盖占位；
- `registerSubpage(id, { title, render(el), onShow? })` + `openSubpage(id)` / `closeSubpage()`：子页 id 见 `shell.ts` SUBPAGE_META（`sp-backup` / `sp-calendar` / `sp-recurring` / `sp-budget` / `sp-reimburse` / `sp-categories` / `sp-entry-detail` / `sp-trash` / `sp-home-custom` / `sp-search` / `sp-settings`）；
- `setFabAction(fn)`：M1-A 注册「记一笔」抽屉后替换 FAB 行为；
- 工具：`showToast(msg)` · `confirmDialog(opts)` · `openSheet({ariaLabel, render, onClose?})` / `closeSheet()`。

## 已知遗留事项

1. 无单侧 accountId 的转账和借贷分别经 `findTransferDuplicates`、`findLoanDuplicates` 按双账户查询；借贷另包含 loanKind；
2. Dexie 不能索引布尔值，`recurringRules` 的 `[enabled+nextRunAt]` 索引实际失效，`runDueRules` 已用全表 filter 兜底（规则量小，无性能问题）；
3. 周期账 amountConfirm「待确认」仅有数据接口（`onPendingConfirm`），通知 UI 由 M2-C 实现；
4. 自动备份到期检测在 `scheduler.catchUp` 中留有 TODO(M3)。
