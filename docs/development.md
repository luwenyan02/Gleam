# 开发指南

## 环境

- Node.js 22
- npm 10
- Python 3.11+（仅端到端测试）
- Android Studio / JDK 21（仅 Android）

Android 命令行构建请通过 `JAVA_HOME` 选择 JDK 21；不要把 `org.gradle.java.home` 的机器绝对路径提交到 `gradle.properties`。

## 启动

```bash
cd app
npm ci
npm run dev
```

## 验证

```bash
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
6. 保存本地 Git 提交与验收记录。按 [AGENTS.md](../AGENTS.md) 的本地维护约定交付，不推送远端或创建 GitHub PR。
