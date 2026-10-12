# 开发指南

## 云任务入口

先读 [项目状态与交接](PROJECT_STATUS.md)。Gleam 云任务使用 `python3 scripts/cloud-env.py setup` 初始化、`python3 scripts/cloud-env.py verify` 完整验证；固定 Node 22.23.3/npm 10.9.9 和 Playwright 1.59.0。干净依赖恢复、系统库要求与持久性边界见 [云环境指南](CLOUD_DEVELOPMENT.md)。Android 构建继续由现有 GitHub CI 执行，不在云网页任务读取签名材料。

## 环境

- Node.js 22
- npm 10
- Python 3.11+（仅端到端测试）
- JDK 21、Android SDK 平台 36 及包含 `aapt`、`apksigner` 的构建工具（仅 Android；可通过 Android Studio 安装）

Android 命令行构建请通过 `JAVA_HOME` 选择包含 `javac` 的完整 JDK 21，并设置 `ANDROID_HOME`；不要把 `org.gradle.java.home` 的机器绝对路径提交到 `gradle.properties`。项目使用 Gradle Wrapper，无需另装全局 Gradle。

## 启动

日常本地预览固定使用 OrbStack 常驻服务。在项目根目录执行：

```sh
sh scripts/preview-local.sh up
```

打开 <http://localhost:5173/>；状态与排错见[本地预览说明](LOCAL_PREVIEW.md)，不要同时启动另一份占用该端口的服务。仅在未使用 OrbStack 常驻预览的环境中，可在 `app/` 安装依赖后运行 `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`。浏览器回归默认使用独立的 `127.0.0.1:4617` 生产预览，不占用日常预览地址。

## 验证

从项目根目录开始执行：

```bash
cd app
npm ci
npm audit --audit-level=high
npm run check:secrets
npm run test:unit
npm run build
npm run test:e2e
```

首次运行浏览器测试：

```bash
python3 -m pip install -r e2e/requirements.txt
python3 -m playwright install chromium
```

测试截图和下载文件写入仓库根目录 `.tmp/tests/`，不进入 Git。

完整浏览器回归结束后会运行 `e2e/capture_readme.py`，在四种屏幕宽度下生成七组项目预览。它使用独立虚构数据库与本地模拟 AI，输出到 `.tmp/tests/e2e/readme/`；需逐张检查后才将选定图片更新到 `docs/assets/screenshots/`。复现与来源记录见[界面预览说明](assets/screenshots/README.md)。

`test_large_ledger.py` 使用 10,000 笔虚构账单，筛选耗时须小于 10 秒；整批改分类从确认操作到结果列表恢复可用须小于 20 秒（2026-10-02 按用户决定由 15 秒调整）。两者均保留真实浏览器计时，整批修改仍须精确验证目标分类 10,000 笔、原分类 0 笔且无页面错误。调整的是该场景的验收预算，不代表运行速度提升，也不改变其他套件、正确性断言或测试顺序。

## 编码约定

- DOM 输出中的用户文本必须经 `core/esc.ts` 转义。
- 金额解析和格式化只使用 `core/money.ts`。
- 数据写入只经过对应 `core/repo`，多表更新使用 Dexie 事务。
- API Key、WebDAV 密码和 S3 密钥只能通过 `core/secretStore.ts` 读取或保存，不得新增明文设置项。
- CSS 优先复用 `styles/tokens.css`；交互控件须有可见焦点和不小于 44px 的触控区域。
- UI 变更保留 `data-qoder-id`、`data-qoder-source` 等已有来源属性。

## 变更流程

1. 写一条能复现需求或缺陷的失败测试。
2. 完成最小实现并让该测试通过。
3. 运行相关回归及生产构建。
4. 在真实浏览器检查手机和桌面状态。
5. 更新说明文档和 `CHANGELOG.md`。
6. 保存 Git 提交与验收记录，按 [AGENTS.md](../AGENTS.md) 的维护约定合入 `main`；远端推送或 PR 按用户授权范围执行，推送后核对提交与 GitHub CI。
7. 发布 Android 时从最终合并提交执行完整构建和当前授权证书核验，按[发布指南](release.md)单独上传 APK 与校验文件。本轮不补发历史版本；新证书不能覆盖旧证书安装，没有完成其他真机验收时保留候选标记并列出待验项目。
