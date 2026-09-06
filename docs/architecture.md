# 架构说明

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

## 核心不变量

- 金额以整数分存储，实体金额恒为正，方向由账单类型决定。
- 转账和借贷不计入普通收支。
- 退款反向影响账户和支出统计，并关联原支出。
- 报销到账和原支出分别建模，避免覆盖历史事实。
- 账单与生活记录先软删除，回收站到期后再物理清除。
- 备份不包含云服务与 AI 的凭据。
- 旧版明文凭据迁移后立即从 IndexedDB 清空，安全存储失败时要求用户重新输入。

## UI 状态

一级页面由 shell 保持，非活动页面必须同时设置隐藏、`aria-hidden` 和 `inert`。子页面通过路由栈保存返回位置；抽屉和对话框负责焦点锁定及焦点恢复。

## 扩展原则

新增能力优先扩展已有仓库和内部类型；只有持久化实体确实需要新增字段时才升级 Dexie schema，并同时提供迁移、回滚与备份恢复测试。
