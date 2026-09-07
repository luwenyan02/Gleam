# 应收应付账户借贷 Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the bounded import/export task; the main agent owns the shared ledger and UI. Steps use checkbox syntax for tracking.

**Goal:** 四类借贷均为资金账户与应收应付账户之间的双边流水，保留借贷业务标签和挖财导入导出能力。

**Architecture:** `Entry.type='loan'` 保留，改以 `fromAccountId/toAccountId` 驱动两边余额，`loanKind` 仅描述借入、借出、还款、收款。应收应付来自 `accounts.group='receivable'`。旧对象表停止业务读写，不迁移、不清库、不新增备份步骤；既有备份功能维持原样。

**Tech Stack:** Vite、TypeScript、Dexie、Vitest、Python Playwright、Capacitor。

## 1. 共享账务契约

Files: `app/src/core/loanLedger.ts`、`app/src/core/entryEffects.ts`、`app/src/core/repo/entryRepo.ts`、`app/src/core/ledgerEvents.ts`、`app/src/core/repo/statsRepo.ts`、`app/tests/loan-ledger.test.ts`。

- [x] 写失败测试：四类借贷各 10000 分，资金与应收应付变化相反，净变化与收支汇总均为零。
- [x] 实现统一方向函数：
  ```ts
  const outgoing = kind === 'lend' || kind === 'repay';
  return outgoing
    ? { fromAccountId: fundId, toAccountId: loanId }
    : { fromAccountId: loanId, toAccountId: fundId };
  ```
- [x] 借贷新增/编辑/导入在同一事务校验两账户存在、不同，往来一侧必须为 receivable、资金一侧必须不是 receivable；失败整笔回滚。
- [x] 写入、删除、恢复、账户流水和净资产趋势共用 `accountEffects`；新增不再更新 loanContacts。
- [x] 借贷去重包括时间、金额、loanKind 和双账户，不能仅按资金账户误跳过另一往来账户。
- [x] 执行 `npm run test:unit -- tests/loan-ledger.test.ts`，核对绿灯。

## 2. 账户化交互

Files: `core/repo/loanRepo.ts`、`features/entry/entrySheet.ts`、`entryTypeForms.ts`、`entryWorkspace.ts`、`features/loan/loan.ts`、`features/account/account.ts`、`features/home/home.ts`、`features/detail/detail.ts`、`entryView.ts`、`features/search/search.ts`。

- [x] loanRepo 只筛选与管理应收应付账户，不创建独立对象。
- [x] 工作台从应收应付账户选择往来账户；资金选择器排除该分组；新建往来直接建立 receivable 账户，初始零余额。
- [x] 借出/还款：资金账户 → 应收应付；借入/收款反向。编辑和再记从双账户还原选择，换类型不遗留关联字段。
- [x] 账户详情进入借贷时预设正确一侧；我的借贷入口展示同一组应收应付账户，并复用账户详情。
- [x] 首页、明细和详情显示两端账户名称，历史独立对象不再作为名称或余额来源。

## 3. 挖财导入导出（独立子任务）

Files: `features/import/wacai.ts`、`features/import/import.ts`、`features/backup/excel.ts`、`tests/wacai-loan.test.ts`。

- [x] 用虚构 Excel 覆盖“收付账户单值 + 收付款人双边”和“收付账户双边”两种借贷表示，四种类别方向都须正确。
- [x] 解析结果中同时提供 fromAccountName/toAccountName，以及标记应收应付侧的 loanAccountName；保留 accountName 为资金侧供兼容显示。
- [x] 映射步骤把借贷对方列为账户且限定 receivable，不按同名匹配到普通账户；不再 ensureLoanContact。
- [x] 两腿金额或方向不符、缺少对方、模糊多方时进入错误列表，不猜“未指明对象”。
- [x] 导出仍保留借贷类型和四种类别，用账户名生成收付款人和收付账户，可再次导入；去重按双账户与种类。
- [x] 执行 `npm run test:unit -- tests/wacai-loan.test.ts`，核对解析/往返测试。

## 4. 端到端与交付

Files: `app/e2e/test_loan_accounts.py`、既有借贷测试与夹具、`app/e2e/run_all.py`、版本与说明文档。

- [x] 新账户种子：资金 100000 分、应收应付 0；依次借出10000、收回10000、借入10000、还款10000，核对两边余额、净资产、收支、详情流水。
- [x] 覆盖编辑、删除恢复、再记、同名普通账户隔离、重复导入与不同往来账户不误判重复。
- [x] 360/390/430px 与桌面真实浏览器检查，测试数据只在独立上下文生成。
- [x] 运行 `npm run test:unit`、`npm run build`、`npm run test:e2e`、`npm run check:secrets`。
- [x] 规格与代码独立审查后，构建原签名本地 APK，核对版本与资源，保存本地 Git 提交；不访问 GitHub。
