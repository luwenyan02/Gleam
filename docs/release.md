# 发布指南

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
npx cap sync android
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

构建并验证：

```bash
cd app/android
./gradlew assembleRelease
```

发布前必须比较 APK 证书指纹，并在安装旧版本的设备上完成覆盖安装、启动和备份恢复验证。

## GitHub Release

1. 合并已通过 CI 的 Pull Request。
2. 创建与 `package.json` 一致的 `vX.Y.Z` 标签。
3. 创建 Release，填写用户可理解的新增、修复、兼容和升级提示。
4. 上传 APK/AAB 及 SHA-256 校验文件，不提交到源码目录。
