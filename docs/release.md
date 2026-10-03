# 构建与 GitHub 发布指南

当前恢复通过 GitHub 维护源码与文档。本轮仅发布验证后合并到 `main` 的最新 Android 安装包，不补发历史版本或调整历史 Release。安装包与校验文件通过 GitHub Releases 分发，不进入源码历史。

当前源码版本为 `1.9.0`（Android `versionCode` 为 `10900`），新增本机可核对的趋势、分类分析与限定追问。用户已授权本路线在最终提交 CI 通过后合并和发布；任何 CI 问题必须先确认，再修复或重试。当前构建环境缺少既有发布签名材料，暂不能构建新的同签名 APK；此授权不允许生成替代签名或把源码检查当作 APK 发布完成。

[v1.8.0 已于 2026-10-02 发布](https://github.com/luwenyan02/Gleam/releases/tag/v1.8.0)，对应源码提交 `8707ddc`；其 APK、SHA-256 校验文件及验证记录仍在原发布页。本轮继续使用相同包名与该版本的发布证书，不重新生成密钥；签名一致性只说明满足覆盖更新的必要条件，不等同于已完成真机升级验收。

当前候选包仍需验证真实设备上的安装、覆盖更新、输入法、返回手势、读屏与备份恢复；外部模型仅做模拟请求回归。以下为一般构建与发布流程；执行时仍须满足当前授权、最终提交检查和既有签名条件。

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

2026-10-02 用户确认原签名不可用，并明确批准在受控云端构建环境中生成、保存新的发布密钥，保留包名 `com.gleam.shiguang`。本轮不要求旧版本覆盖升级；新证书无法直接覆盖旧证书安装。旧版用户须先导出并妥善保存加密备份，再卸载旧版、安装新版并恢复；卸载会删除应用本地数据，没有备份时不要卸载。真实设备上的导出、重装与恢复尚需验证。

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
E8:E6:CA:55:E4:BB:1A:E4:C3:08:5F:13:0C:25:CC:D4:E9:37:B7:0C:74:5E:3F:65:70:64:B5:90:FE:FA:18:DC
```

校验脚本固定核验此公开指纹；后续发布须继续使用对应私钥。私钥和口令保存在仓库之外，目录权限为 `0700`、文件权限为 `0600`；不得进入源码、日志、APK、Release 附件或 GitHub 仓库（包括私有仓库）。本地生成不等于已完成长期安全备份，密钥交接与备份须另行安排。

使用包含 `javac` 的完整 JDK 21，通过 `JAVA_HOME` 选择；设置 `ANDROID_HOME` 为本机 SDK 目录，并安装 Android SDK 平台 36 及包含 `aapt`、`apksigner` 的构建工具。项目使用 Gradle Wrapper 8.14.3、Android Gradle Plugin 8.13.0，最低支持 Android API 24，编译与目标 API 为 36。

从最终合并提交统一构建并验证：

```bash
cd app
npm run build:android
```

该命令依次执行网页生产构建、Capacitor 同步、Gradle 单元测试、release 打包和 `verify:apk`。不要只执行 `assembleRelease` 后直接发包，否则可能带入旧网页。

`dist/build-info.json` 由构建读取源码版本自动生成。校验脚本比较 APK 原生版本与源码版本，并检查本次 `dist/` 的每个网页文件都存在于 APK 且逐字节一致，同时验证当前授权发布证书。版本不符、遗漏资源和被替换的 JS 会使校验失败。

也可单独验证一个候选包：

```bash
npm run verify:apk -- /absolute/path/to/Gleam-vX.Y.Z.apk
```

这只证明构建产物一致，不代表完成设备验收。本轮已排除旧证书版本的覆盖升级；输入法、返回手势、读屏、启动和备份恢复仍须在真实设备验证。没有设备时仅提供明确标记的候选包，并列出未验证项，不宣布正式验收通过。

## GitHub 发布

1. 完成适用测试、浏览器验收与敏感信息检查，更新文档与验证记录，再将本轮分支合入 `main`。核对远端 `main` 的最终提交及该提交的 GitHub CI；合并后的相关检查须重跑，不能用旧提交的通过结果代替。
2. 从同一最终提交执行 `npm run build:android`，将核验通过的 APK 保存为项目根目录 `release/Gleam-vX.Y.Z.apk`（`release/` 被 Git 忽略），生成对应 SHA-256 校验文件。签名材料只能留在受控构建环境中，不得上传为 Release 附件。
3. 核对版本标签与 `package.json` 一致，并指向构建所用的最终提交。创建对应 GitHub Release，只附本轮 APK 与校验文件；发布说明列出源码提交、已运行检查、升级备份提示和仍待验证的项目。
4. 若真机验收未完成，Release 标题与说明明确写“候选版”，并设为预发布；不得宣布正式验收通过。未完成或受阻的检查如实列出，不复用历史测试数量。
5. 上传后核对 Release 标签、附件名称与大小，并下载附件复核 SHA-256，确认与本地已核验产物一致后再提供下载链接。候选预发布不保证出现在 GitHub 的 `/releases/latest`，交付时使用已验证的具体 Release 链接。

当前 `.github/workflows/ci.yml` 运行网页检查、浏览器回归和 Android 单元测试，尚未自动生成、签名或上传安装包；CI 通过不能代替以上 Android 发布步骤。另行妥善保存已交付安装包的本地副本。

## 功能边界

- 当前 Android 交付流程针对 APK；PWA 可使用网页生产构建。仓库没有 iOS、Windows 或 macOS 原生安装包工程。
- 实时语音仅在配置了本机中转的开发网页版中可用，Android 安装包与离线 PWA 不包含中转服务，见[实时语音说明](REALTIME_VOICE.md)。
