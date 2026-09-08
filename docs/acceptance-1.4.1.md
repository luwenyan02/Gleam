# v1.4.1 本地交互验收

日期：2026-09-08。本版本是验收候选，不等同于整个 APP 的账务审计已通过。

## 本次完成

1. 首页、搜索、账户共用明细文案：上行分类或“分类退款”，下行月日、时分、账户；转账和借贷展示双方方向，不再重复类型。备注、报销状态、报销净额说明与原金额计算保留。
2. 账户每笔金额下显示交易后余额。由全部账户现金流倒推，再按月展示；不把当前余额重复放在每行，不新增持久化字段。同时间同 id 的支出与报销到账按先支出、后到账排序。
3. 日期、年月、选择器、抽屉接入同文档返回层级；返回先关顶层，保留外层记账草稿与焦点。手动确认/取消也清理相应历史。
4. 修复两处关联竞态：关闭抽屉立即打开模板管理，以及刚打开子页又快速返回时的历史写入取消。

仅借鉴本地挖财截图的布局，没有将其个人数据或截图复制到正式资源。

## 验证结果

| 项目 | 结果 |
| --- | --- |
| 正式单元测试 | 65 / 65 通过，包括 4 个逐笔余额测试、5 个共用文案测试 |
| 类型检查、Vite 生产构建 | 通过；既有 XLSX 分包及 WebDAV 混合导入警告仍存在 |
| 完整真实浏览器回归 | 10 个脚本全部通过 |
| 本次新增 UI 回归 | 14 场景通过：四档明细、四档逐笔余额、浏览器日期返回、系统返回事件、选择器返回、确认重开、模板跳转、快速返回 |
| 视口 | 360、390、430、1024px |
| 原全面审计 F10 | 独立重跑 `browser_back_overlay` 由失败变为通过；不再遗留背景 inert |
| Android | Capacitor 同步、Gradle `testDebugUnitTest assembleRelease` 任务通过；该原生单测当前仅为已有示例且命中缓存，不能代表原生业务验收 |
| APK 一致性 | Android / Web 均为 1.4.1；20 个网页文件逐字节一致；原发布签名证书有效 |
| 敏感信息检查 | 通过，无 GitHub 上传或远端变更 |

测试使用 fake-indexeddb 或新的浏览器上下文和虚构账目，没有读取/清空用户手机或现有浏览器账本。独立代码审查发现的两处历史竞态均已补失败复现并修复；最终未留 Critical / Important 审查项。

最终回归日志：[ui-followup-verified.log](/Users/wenyan/AI_Projects/Gleam/.tmp/reports/full-audit/ui-followup-verified.log)。原全面审计：[全面测试报告](/Users/wenyan/AI_Projects/Gleam/.tmp/reports/full-audit/全面测试报告.md)。

截图：[首页](/Users/wenyan/AI_Projects/Gleam/.tmp/tests/e2e/screenshots/list-home-390.png)、[搜索](/Users/wenyan/AI_Projects/Gleam/.tmp/tests/e2e/screenshots/list-search-390.png)、[账户逐笔余额](/Users/wenyan/AI_Projects/Gleam/.tmp/tests/e2e/screenshots/account-running-balance-390.png)。截图均为自动生成的虚构数据。

## 本地体验

电脑访问 [本地预览](http://127.0.0.1:4173/)，已有页面请用 `Cmd+Shift+R` 强制刷新。如果电脑重启后服务关闭，在 `app/` 执行：

```bash
npm run build
npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
```

手机验收包：[Gleam-v1.4.1-candidate.apk](/Users/wenyan/AI_Projects/Gleam/.tmp/artifacts/releases/Gleam-v1.4.1-candidate.apk)。它使用原签名且提高了版本号，但本次未连接手机，尚未实际执行覆盖安装。

SHA-256：`42e49d23000eb07d873d6b846bfb65f148178520ecf0d7788e684d814f550770`。

## 待真机验收

- 用该包覆盖安装旧版，确认版本为 1.4.1。
- 记账填金额/备注 → 日期选择 → 系统返回：只关日期，金额与备注保留；再返回关闭记账。
- 设置平台选择、搜索日期、报表年月选择分别验证返回与重开。
- 检查真实输入法、返回手势、TalkBack、底部安全区，以及本地备份导出/恢复。

## 仍未整体放行的原因

原全面审计中的计算器除零/负中间结果、周期账待确认双击重复入账、同批 Excel 去重、外币分摊折算、日历/生活报销口径、异常保存重试及备份结构完整性等问题，不属于这次三项交互修改，尚未修复。本候选包适合继续交互验收，不建议作为唯一正式账本。

完整回归命令：`npm run test:unit`、`npm run build`、`npm run test:e2e`、`npm run check:secrets`。其中审计故意保留的失败断言在 `.tmp/tests/full-audit/`，不混入“正式单元测试全部通过”的统计。
