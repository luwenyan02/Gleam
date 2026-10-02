# 拾光 Gleam

> 本地优先的记账与生活记录应用。

[![Android](https://img.shields.io/badge/Android-Capacitor-3DDC84)](https://capacitorjs.com/)
[![PWA](https://img.shields.io/badge/PWA-offline--ready-D66A2C)](https://developer.mozilla.org/docs/Web/Progressive_web_apps)

拾光把日常账目、账户变化、生活随记和习惯记录放在同一个本地应用中。数据默认保存在设备内；云备份、AI 识别与生活 AI 均为用户主动配置的可选能力。

> 当前恢复通过 GitHub 维护源码与文档。本轮计划仅发布合并后的最新 Android 安装包，不补发历史版本。当前源码版本为 v1.8.0；安装包是否已发布、候选状态与验证范围以 [GitHub Releases](https://github.com/luwenyan02/Gleam/releases) 中的实际发布说明为准。

## 为什么是拾光

- **本地优先**：无需注册账号即可使用，核心数据保存在本机。
- **完整记账口径**：支持支出、收入、转账、借贷、退款和报销。
- **记账与生活相连**：一笔账可以关联当天的日记、照片或习惯记录。
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
- 拾光周刊：选择素材、编辑预览并确认收藏；生活整理稿经用户确认后才保存
- 可选的 OpenAI 兼容文本/图片账单识别；低置信度进入待确认收件箱，达到用户阈值且映射完整时可自动入账
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

以下为 2026-09-07 及之前版本的历史截图，使用虚构演示数据生成，不包含真实账目或个人信息；未展示当前版本的聊天、周刊等新增界面。

界面现采用浅灰背景、白色卡片、深色文字和橙红重点；参考挖财的清晰布局，保留拾光的记账与生活双模块。

<!-- SCREENSHOTS_START -->
| 快速总览 | 报表下钻 | 生活时间流 |
| --- | --- | --- |
| ![拾光首页虚构数据演示](docs/assets/screenshots/home-demo.png) | ![拾光分类报表虚构数据演示](docs/assets/screenshots/report-demo.png) | ![拾光生活时间流虚构数据演示](docs/assets/screenshots/life-demo.png) |
<!-- SCREENSHOTS_END -->

[借贷双账户预览](docs/assets/screenshots/loan-demo.png)：资金账户与应收应付账户之间的本金划转。

## 安装与使用

- Android 安装包发布后，可从 [GitHub Releases](https://github.com/luwenyan02/Gleam/releases) 下载 APK 与 SHA-256 校验文件；安装前阅读对应版本的验证范围和升级提示。
- 升级前在“我的 → 数据与备份”保存一份加密备份，保留原应用数据并覆盖安装。
- 未完成全部真机验收的包标记为候选版，具体待验项目以发布说明为准。
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

完整功能变化和历史验证记录见[更新记录](CHANGELOG.md)。历史版本的通过记录不能代替当前合并提交的测试结果；发布前需重新完成适用检查，Android 产物还需核对原证书、版本与网页资源一致性。构建通过不代表真机验收已完成。

## 参与维护

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。使用短分支开发，完成测试、构建、敏感信息扫描与必要的浏览器验收后合入 `main`。GitHub CI 用于验证提交；Android 安装包另行完成原证书签名与产物核验后上传 Releases。所有 UI 变更需附真实浏览器截图和验证结果。

## 常见问题

**数据会自动上传吗？**

核心数据默认留在本机。主动使用云备份、AI 记账或生活 AI 时，相关数据会发送到选定服务；开发网页版实时语音在单独同意后将麦克风声音发送给阿里云百炼。具体发送内容见[隐私说明](PRIVACY.md)。

**换手机如何迁移？**

在旧设备生成加密 `.skbak` 文件，在新设备选择恢复；恢复前请妥善保存原文件和口令。

**为什么源码目录没有 APK？**

APK 与校验文件通过 GitHub Releases 单独分发，不提交到源码历史。本地构建产物保存在被 Git 忽略的 `release/` 目录。
