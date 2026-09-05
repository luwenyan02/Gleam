# 拾光 Gleam

> 本地优先的记账与生活记录应用。

[![CI](https://github.com/luwenyan02/Gleam/actions/workflows/ci.yml/badge.svg)](https://github.com/luwenyan02/Gleam/actions/workflows/ci.yml)
[![Android](https://img.shields.io/badge/Android-Capacitor-3DDC84)](https://capacitorjs.com/)
[![PWA](https://img.shields.io/badge/PWA-offline--ready-D66A2C)](https://developer.mozilla.org/docs/Web/Progressive_web_apps)

拾光把日常账目、账户变化、生活随记和习惯记录放在同一个本地应用中。数据默认保存在设备内；云备份与 AI 识别均为用户主动配置的可选能力。

> 当前仓库为私人维护项目，暂未开源。公开发布前将另行确定许可证。

## 为什么是拾光

- **本地优先**：无需注册账号即可使用，核心数据保存在本机。
- **完整记账口径**：支持支出、收入、转账、借贷、退款和报销。
- **记账与生活相连**：一笔账可以关联当天的日记、照片或习惯记录。
- **数据可带走**：支持加密备份、Excel 导入导出、WebDAV 与 S3 兼容备份。
- **多端形态**：提供 Android 应用，并可作为离线 PWA 使用。

## 主要能力

<details open>
<summary><strong>记账与明细</strong></summary>

- 四类账单与连续计算器
- 常用分类、速记模板、标签和商家
- 历史补账、周期账、退款、报销与回收站
- 关键词、日期、类别、账户、标签、商家和金额筛选

</details>

<details>
<summary><strong>账户与报表</strong></summary>

- 现金、银行卡、信用卡、网络账户、投资账户与储值账户
- 周、月、年和自定义周期分析
- 趋势、分类、账户和标签维度下钻
- 预算、净资产与借贷对象管理

</details>

<details>
<summary><strong>生活记录与智能能力</strong></summary>

- 日记、照片、习惯打卡时间流
- 账目与生活记录互相关联
- 可选的 OpenAI 兼容文本/图片账单识别
- 分享到拾光后先校验；低置信度进入待确认收件箱，达到用户阈值且映射完整时可自动入账

</details>

## 界面预览

界面截图使用虚构演示数据生成，不包含真实账目或个人信息。

<!-- SCREENSHOTS_START -->
| 快速总览 | 报表下钻 | 生活时间流 |
| --- | --- | --- |
| ![拾光首页虚构数据演示](docs/assets/screenshots/home-demo.png) | ![拾光分类报表虚构数据演示](docs/assets/screenshots/report-demo.png) | ![拾光生活时间流虚构数据演示](docs/assets/screenshots/life-demo.png) |
<!-- SCREENSHOTS_END -->

## 安装与使用

- Android 安装包从 [GitHub Releases](https://github.com/luwenyan02/Gleam/releases) 获取。
- PWA 可通过本地构建或受信任的静态站点安装。
- 升级 Android 版本前建议先在“我的 → 数据与备份”生成一份加密备份。

## 本地开发

需要 Node.js 22、npm 10；运行端到端测试还需要 Python 3.11+ 和 Playwright。

```bash
cd app
npm ci
npm run dev
```

提交前至少执行：

```bash
npm run check:secrets
npm run test:unit
npm run build
npm run test:e2e
```

更多信息见[开发指南](docs/development.md)、[架构说明](docs/architecture.md)、[数据与备份](docs/data-backup.md)和[发布指南](docs/release.md)。

## 路线图

- `v1.1`：快速记账与渐进披露（已完成）
- `v1.2`：统一明细查询、报表下钻和账户趋势（已完成）
- `v1.3`：生活时间流、设置分组、安全存储和可访问性（已完成）
- 后续：导入适配扩展、性能优化与公开发布准备

## 参与维护

当前仅接受仓库协作者提交。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，所有 UI 变更需附真实浏览器截图和验证结果。

## 常见问题

**数据会自动上传吗？**  
不会。只有主动启用 WebDAV、S3 或 AI 识别时，相关数据才会发送到用户选择的服务。

**换手机如何迁移？**  
在旧设备生成加密 `.skbak` 文件，在新设备选择恢复；恢复前请妥善保存原文件和口令。

**为什么仓库没有 APK？**  
二进制安装包通过 Releases 发布，避免污染源码历史。
