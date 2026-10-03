# 拾光 Gleam

> 本地优先的记账与生活记录应用。

[![Android](https://img.shields.io/badge/Android-Capacitor-3DDC84)](https://capacitorjs.com/)
[![PWA](https://img.shields.io/badge/PWA-offline--ready-D66A2C)](https://developer.mozilla.org/docs/Web/Progressive_web_apps)
[![v1.8.0](https://img.shields.io/badge/release-v1.8.0-orange)](https://github.com/luwenyan02/Gleam/releases/tag/v1.8.0)

记清每一笔钱，也留住日常的小片段。拾光把账目、账户、预算报表和生活记录放在同一个本地应用中：可以快速记一笔、写一句随记，也可以和拾光聊聊，再把选中的片段整理成周刊。数据默认保存在设备内；云备份、AI 识别与生活 AI 均为用户主动配置的可选能力。

> [v1.8.0 已于 2026-10-02 发布](https://github.com/luwenyan02/Gleam/releases/tag/v1.8.0)，提供 Android APK 与 SHA-256 校验文件。自动化检查已通过，真实设备的安装、输入法、返回手势和备份恢复等仍未验证；安装前请阅读发布说明与下方升级提示。

当前源码为 **v1.9.0 候选版**，新增可核对的账本趋势、分类与限定追问。本轮按用户选择复用原本地签名，不能直接覆盖云端签名的 v1.8.0／v1.8.1；安装前须把可用加密备份另存到应用之外。签名一致不代表真机升级已验收。构建与验证边界见[发布指南](docs/release.md)。

## 为什么是拾光

- **本地优先**：无需注册账号即可使用，核心数据保存在本机。
- **完整记账口径**：支持支出、收入、转账、借贷、退款和报销。
- **记账与生活相连**：一笔账可以关联生活记录，补充照片、感受和回访。
- **数据可带走**：支持加密备份、Excel 导入导出、WebDAV 与 S3 兼容备份。
- **多端形态**：提供 Android 应用，并可作为离线 PWA 使用。

## 主要能力

<details open>
<summary><strong>记账与查账</strong></summary>

- 支出、收入、转账与借贷，支持连续计算器、退款、报销、周期账和速记模板
- 按历史与记账时段推荐分类、按分类推荐记账账户；手选优先
- 日历查账、关键词与多条件筛选、批量整理；分类、账户、标签和商家明细下钻
- 普通账单最多附 9 张图片凭证；支持微信、支付宝与挖财账单导入、回收站与恢复

</details>

<details>
<summary><strong>账户与报表</strong></summary>

- 资金账户与应收应付账户统一管理，支持对账、排序、隐藏和净资产范围设置；借贷本金按双账户划转
- 信用卡账单、分次还款关联、信用额度与到期提醒
- 月度与年度预算、历史预算、财务月起始日，以及周、月、年和自定义周期报表
- 净资产与账户余额走势默认收起，可选择历史月份查看月末变化；账户明细展示逐笔余额
- Android 快捷记账入口与月度记账小组件

</details>

<details>
<summary><strong>拾光与 AI</strong></summary>

- 快速记录、照片、习惯打卡、账单关联与生活回访
- 和拾光聊聊：流式回复、会话历史、停止与重试、草稿恢复和 Markdown 展示
- [可核对的账本分析](docs/AI_LEDGER_ANALYSIS.md)：本机单月分类、上月对比和近 6 月趋势，逐次预览确认，结果可查原账单，固定追问不会自动改账
- 拾光周刊：选择素材、编辑预览并确认收藏；生活整理稿经用户确认后才保存
- 可选的 OpenAI 兼容文本/图片账单识别；低置信度进入待确认收件箱，达到用户阈值且映射完整时可自动入账
- [Android 百炼短语音记账](docs/SHORT_VOICE_ENTRY.md)：独立个人语音 Key，短句转写后核对文字，再生成单笔支出/收入草稿；语音草稿始终人工确认，录音不归档。真实服务/真机验收状态见文档
- 实时语音仅支持配置了本机中转的开发网页版；Android 安装包与离线 PWA 暂不支持，详见[实时语音说明](docs/REALTIME_VOICE.md)

</details>

<details>
<summary><strong>数据与备份</strong></summary>

- 核心数据默认保存在本机，无需注册账号
- 加密 `.skbak` 备份与恢复、Excel 导入导出、可选 WebDAV / S3 兼容备份
- 完整备份包含生活记录、会话与附件；Excel 不替代完整备份
- AI 与云服务的数据发送范围见[隐私说明](PRIVACY.md)

</details>

## 界面预览

以下为 **v1.8.0 网页生产构建的真实浏览器截图**，于 2026-10-02 使用隔离环境中的虚构数据生成。聊天与周刊采用本地模拟回复，不调用真实外部模型，也不包含真实账目或个人信息。它们展示网页端界面，不代表 Android 真机验收已完成。

浅灰背景、白色卡片、深色文字和橙红重点，配合固定的「账户｜报表｜记一笔／首页｜拾光｜我的」底部入口。下图可点击查看原尺寸。

<!-- SCREENSHOTS_START -->
| 首页 · 收支与预算 | 账户 · 余额与净资产 | 报表 · 分类与趋势 |
| --- | --- | --- |
| ![v1.8.0 首页：本月收支、预算剩余与日常流水，虚构数据](docs/assets/screenshots/home-demo.png) | ![v1.8.0 账户：资金账户、应收应付与净资产，虚构数据](docs/assets/screenshots/accounts-demo.png) | ![v1.8.0 报表：财务周期、分类占比与收支汇总，虚构数据](docs/assets/screenshots/report-demo.png) |

| 拾光 · 随记与习惯 | 和拾光聊聊 · AI 对话 | 拾光周刊 · 收藏片段 |
| --- | --- | --- |
| ![v1.8.0 拾光：快速记录、生活时间流与习惯打卡，虚构数据](docs/assets/screenshots/life-demo.png) | ![v1.8.0 AI 聊天：新聊天、设置、会话与整理入口，本地模拟回复](docs/assets/screenshots/chat-demo.png) | ![v1.8.0 拾光周刊：经确认收藏的每周生活片段，本地模拟内容](docs/assets/screenshots/weekly-demo.png) |
<!-- SCREENSHOTS_END -->

[借贷双账户预览](docs/assets/screenshots/loan-demo.png)：资金账户与应收应付账户之间的本金划转。截图来源、演示数据与复现方式见[预览说明](docs/assets/screenshots/README.md)。

## 安装与使用

- Android 7.0 及以上：从 [v1.8.0 发布页](https://github.com/luwenyan02/Gleam/releases/tag/v1.8.0) 下载 APK 与 SHA-256 校验文件；安装前阅读对应版本的验证范围和升级提示。
- 本轮复用原本地证书，不能直接覆盖云端签名的 v1.8.0／v1.8.1。使用这两个云端版本的用户，应先在“我的 → 数据与备份”导出加密备份并另存到应用之外，确认副本可读取，再考虑卸载、安装与恢复；卸载会删除应用内数据，没有可用外部备份时不要卸载。原本地签名系列不应仅因版本较旧而卸载；签名一致也不能代替真机覆盖更新与恢复验收。
- v1.8.0 已作为普通 GitHub Release 发布；这一发布状态不等同于完成真机验收，具体待验项目以发布说明为准。
- PWA 通过网页生产构建和预览使用；实时语音仅在配置了本机中转的开发服务中可用。
- 自行构建的方法见[发布指南](docs/release.md)；本地 APK 与校验文件保存在被 Git 忽略的 `release/` 目录，不进入源码历史。

## 本地开发

日常网页预览由 OrbStack 后台常驻提供，固定使用 <http://localhost:5173/>。在项目根目录运行：

```sh
sh scripts/preview-local.sh up
```

源码修改自动更新，不必保留终端窗口。依赖或环境配置变化后重新执行该命令；状态、停止和排错见[本地预览说明](docs/LOCAL_PREVIEW.md)。OrbStack 必须处于运行状态。不要同时启动另一份占用 5173 的临时服务。

需要 Node.js 22、npm 10；运行端到端测试还需要 Python 3.11+ 和 Playwright。

```bash
cd app
npm ci
# 仅在未使用 OrbStack 常驻预览时手动启动：
# npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

提交前至少执行：

```bash
npm run check:secrets
npm audit --audit-level=high
npm run test:unit
npm run build
npm run test:e2e
```

更多信息见[开发指南](docs/development.md)、[架构说明](docs/architecture.md)、[数据与备份](docs/data-backup.md)和[发布指南](docs/release.md)。

## 版本与验收

v1.8.0 发布提交 `8707ddc` 的[完整 CI](https://github.com/luwenyan02/Gleam/actions/runs/36982150269)已通过：321 项 TypeScript 单元测试、35 个浏览器回归套件与 7 项 Android 单元测试，并完成生产构建、依赖审计和敏感信息检查。APK 的签名、版本及内嵌网页资源另行核验，详见[发布说明](https://github.com/luwenyan02/Gleam/releases/tag/v1.8.0)。

完整功能变化和历史验证记录见[更新记录](CHANGELOG.md)。这些结果对应明确的发布提交，不能代替后续版本或真实设备的验收。

## 参与维护

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。使用短分支开发，完成测试、构建、敏感信息扫描与必要的浏览器验收后合入 `main`。GitHub CI 用于验证提交；Android 安装包另行完成授权证书签名与产物核验后上传 Releases。所有 UI 变更需附真实浏览器截图和验证结果。

## 常见问题

**数据会自动上传吗？**

核心数据默认留在本机。主动使用云备份、AI 记账或生活 AI 时，相关数据会发送到选定服务；开发网页版实时语音在单独同意后将麦克风声音发送给阿里云百炼。具体发送内容见[隐私说明](PRIVACY.md)。

**换手机如何迁移？**

在旧设备生成加密 `.skbak` 文件，在新设备选择恢复；恢复前请妥善保存原文件和口令。

**为什么源码目录没有 APK？**

APK 与校验文件通过 GitHub Releases 单独分发，不提交到源码历史。本地构建产物保存在被 Git 忽略的 `release/` 目录。
