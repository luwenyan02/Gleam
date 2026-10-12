# 拾光项目状态与交接

## 当前正式版本

截至 2026-10-12，**v1.11.1 已正式发布并完成用户手机覆盖安装验收**。

- 仓库：私有 [luwenyan02/Gleam](https://github.com/luwenyan02/Gleam)，默认分支 `main`。
- 发布源码 / 标签 `v1.11.1`：`e96e31b7de2a90adfcb5a8fd2b58e428956a8d39`，合并 [PR #15](https://github.com/luwenyan02/Gleam/pull/15)。此 SHA 是发布基线；后续 main 可正常前进，需每次核验。
- [正式 Release](https://github.com/luwenyan02/Gleam/releases/tag/v1.11.1)：非草稿、非预发布；正式附件沿用用户已验收的原安装包，未重新构建。
- [最终正式 CI 38195964629](https://github.com/luwenyan02/Gleam/actions/runs/38195964629)：同一 SHA，四组普通 CI 成功。后续分支不得继承该通过结论。
- Android：`com.gleam.shiguang`，versionName `1.11.1`、versionCode `11101`，非调试包，沿用原本地 F979 证书。
- 发布页记录的 APK SHA-256：`a468c5bf0915412067b708b52bd64f62d05b9e0f22f6a2ae8f30380493797c86`。本轮环境维护核对发布元数据，没有重新下载验包或读取签名材料。

本版修复覆盖更新后的旧网页缓存，保留账目、设置和安全存储；用户手机验收与 Android API 35 / WebView 124.0.6367.219 自动化证据分开记录，不泛化为全部系统/提供者组合。权限过程被 Activity 重建打断时需主动重新发起语音，不自动恢复录音。旧云端证书签名的 v1.8.0/v1.8.1 无法直接覆盖，升级前保留应用外可用加密备份，详见 [发布指南](release.md)。

## 当前维护工作

通过 Codex Cloud 的 Gleam 保存环境维护网页开发工具链，以 GitHub 保存长期项目资料。用户本轮授权安装官方 Node 22/npm 10、锁定依赖、Playwright/浏览器及必要系统库，补初始化脚本和交接文档、运行验证、创建草稿 PR 与常规 CI；**未授权合并或发布**。

- 从干净依赖目录验证恢复；入口为 `python3 scripts/cloud-env.py setup` 和 `verify`，详见 [云开发环境](CLOUD_DEVELOPMENT.md)。
- Android 构建保留现有 GitHub CI；不把本云目录当作签名主机，不读取/配置真实密钥，不调用真实语音服务，不修改安全权限或保存环境持久设置。
- **持续语音暂缓**，不纳入本轮；既有短语音功能不改动。
- 云任务目录和缓存可重建，不保证永久磁盘。本阶段的结果与剩余阻碍记录在对应草稿 PR；初始化成功不等于长期迁移完成。

## 状态记录规则

本文件与正式 Release 记录当前状态。`CHANGELOG.md` 的旧版本以及 `ANDROID_UPGRADE_CACHE_PROBE.md` 中按提交排列的诊断段落是历史过程记录；其中“候选、待验收、不合并”等措辞只描述当时阶段，不能覆盖上面的最终发布事实，也不扩展新任务授权。后续每轮保留精确提交、验证范围、未运行项、PR 与下一步；不提交密钥、真实用户数据或 APK。
