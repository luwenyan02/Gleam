# 本地构建与交付指南

当前只在本地维护与交付，不创建 GitHub Release 或上传安装包。已有远端发布内容保持原样。

## 版本来源

`app/package.json` 的 `version` 是唯一版本来源。Android `versionName` 直接读取该值，`versionCode` 使用 `major × 10000 + minor × 100 + patch`。

## 发布前检查

```bash
cd app
npm ci
npm audit --audit-level=high
npm run check:secrets
npm run test:unit
npm run build
npm run test:e2e
```

## Android 签名

签名文件和口令不得放入仓库。默认从以下文件读取：

```text
~/Library/Application Support/Gleam/signing/keystore.properties
```

也可设置 `GLEAM_KEYSTORE_PROPERTIES`，或分别设置：

- `GLEAM_KEYSTORE_PATH`
- `GLEAM_KEYSTORE_PASSWORD`
- `GLEAM_KEY_ALIAS`
- `GLEAM_KEY_PASSWORD`

属性文件格式：

```properties
storeFile=/absolute/path/to/gleam-release.keystore
storePassword=<由密码管理器生成>
keyAlias=gleam
keyPassword=<由密码管理器生成>
```

当前发布证书 SHA-256：

```text
F9:79:D4:9C:E5:86:A7:43:8B:CA:F4:4B:CE:C4:B4:ED:AA:9E:80:CB:A1:70:A0:7F:8F:88:95:B7:57:38:00:12
```

使用 JDK 21，设置 `ANDROID_HOME` 为本机 SDK 目录后，统一构建并验证：

```bash
cd app
npm run build:android
```

该命令依次执行网页生产构建、Capacitor 同步、Gradle 单元测试、release 打包和 `verify:apk`。不要只执行 `assembleRelease` 后直接发包，否则可能带入旧网页。

`dist/build-info.json` 由构建读取源码版本自动生成。校验脚本比较 APK 原生版本与源码版本，并将 APK 内每个网页文件与本次 `dist/` 逐字节比较，同时验证原发布证书。旧包、遗漏资源和被替换的 JS 会使校验失败。

也可单独验证一个候选包：

```bash
npm run verify:apk -- /absolute/path/to/Gleam-vX.Y.Z.apk
```

这只证明构建产物一致，不代表完成设备验收。发布前仍须在安装旧版本的设备上完成覆盖安装、输入法、返回手势、读屏、启动和备份恢复验证。没有设备时仅提供明确标记的候选包，不宣布正式验收通过。

## 本地版本交付

1. 完成本地测试与验收，保存源码和说明文档的 Git 提交。
2. 构建并核验 APK，将候选包和 SHA-256 校验文件保存到项目根目录 `release/`（被 Git 忽略），提供本地路径。
3. 真机验收通过后，按需创建与 `package.json` 一致的本地 `vX.Y.Z` 标签，并在 `CHANGELOG.md` 记录新增、修复和升级提示；未验收的包继续标记为候选版。
4. 安装包和签名材料不进入 Git 历史；另行妥善保存重要版本的本地副本。保留的 `.github/` 配置仅供历史参考，不作为当前交付流程。
