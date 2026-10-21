# 可重建的云开发环境

拾光的长期源码、规则和交接记录保存在 GitHub `luwenyan02/Gleam`。用户于2026-10-21临时设为公开，可见性以GitHub实际配置为准。Codex Cloud 的任务目录、依赖缓存和浏览器安装都可丢弃；文件暂时存在不代表永久磁盘承诺，也不保证会话全文长期保留。此流程不自动修改保存环境配置、联网权限或系统安全设置。

## 初始化

支持 Linux x86_64/aarch64，需已有 Python 3.11+（含 venv/pip）、Git、tar/xz、CA 证书和 Chromium 所需系统库。脚本不安装 Android SDK，也不读取签名材料。

```sh
# 从仓库根目录执行；首次安装需要联网。
python3 scripts/cloud-env.py setup
python3 scripts/cloud-env.py check
python3 scripts/cloud-env.py verify
```

- `.node-version` 固定官方 Node 22.23.3，随包 npm 10.9.9，与 `app/package.json` 的 `packageManager` 一致。脚本从 nodejs.org 下载，并在解压前核对入库的 SHA-256；没有全局安装、shell profile 编辑或自动版本升级。
- Node、Python 虚拟环境、浏览器、HOME 和空白起始缓存均放在 `.tmp/cloud-env/`；应用依赖通过 `npm ci --ignore-scripts` 按 `app/package-lock.json` 安装在本 checkout 的 `app/node_modules/`。该命令会替换现有 node_modules，不修改锁文件；使用与 CI 相同的安装策略。
- 浏览器库按 `app/e2e/requirements.txt` 固定 Playwright 1.59.0，并下载该版本匹配的 Chromium。Python 本身要求 3.11+；pip 的间接依赖与宿主系统库不构成完整 OS 镜像锁定，报告应记录实际版本。当前不是逐字节可复现镜像承诺。
- 子命令使用白名单环境变量与隔离 HOME，仅保留平台已有 HTTP(S) 代理与公开 CA 证书路径设置并确保 localhost 直连，不输出代理值；保留 TLS 校验，不增加证书或关闭验证；不继承真实服务 Key、`NODE_OPTIONS`、用户 npm/pip 配置、既有预览 URL 或浏览器覆盖路径。若 app 内存在 `.env`/`.env.*`（示例文件除外），setup/verify/run 会在读取内容前停止；应使用无私有配置的干净 checkout，不删除用户原文件。
- `check` 会实际启动 Chromium。缺少系统库时，根据真实错误，在获准的环境中执行 `python3 scripts/cloud-env.py run python3 -m playwright install-deps chromium`；这一步可能需要系统安装权限。脚本不自动提权，不设置 `--no-sandbox` 或修改设备/网络权限。若被平台拒绝，保留错误和最小依赖清单，不换执行环境绕过。
- 下载需要访问 nodejs.org、registry.npmjs.org、pypi.org/files.pythonhosted.org 以及 Playwright 官方浏览器下载 CDN。若平台禁止联网，应由用户配置允许的安装阶段或预装依赖；不要自行更改保存环境联网权限。

`setup` 可重复执行，但不是离线安装器；首次恢复仍依赖官方下载源可用。它不会调用任何真实 AI/语音服务。环境变量隔离不是操作系统网络沙箱；现有测试使用虚构数据和模拟请求，真实服务验收需另行授权。

## 验证及从零恢复

`verify` 依次执行环境检查、敏感信息扫描、完整单元测试、三个时区离线 AI 评测、`tsc --noEmit`、Vite/PWA 生产构建及完整浏览器 E2E（包括历史资源升级与四宽度演示截图）。任一失败返回非零，不将后续未运行项目标为通过。云验证入口在临时 loopback 端口启动并持有独立生产预览进程，通过 `GLEAM_E2E_URL` 交给现有 E2E runner，结束后关闭；不会复用默认 4617 上可能残留的旧服务，也不依赖用户的 OrbStack 或应用数据。

运行单项或在线依赖审计：

```sh
python3 scripts/cloud-env.py run npm run test:unit
python3 scripts/cloud-env.py run npm audit --audit-level=high
```

要证明从零恢复，先提交待验证变更，再在**新的任务目录或干净 worktree** checkout 该精确提交，确认没有 `app/node_modules/` 和 `.tmp/cloud-env/`，再执行上述 setup/check/verify。不能用已有依赖的测试成功替代安装验证。不要在用户使用中的目录执行清理或重置命令。

本机日志、截图及离线报告保存在 `.tmp/`，不提交依赖、缓存或浏览器。长期记录在 PR 与项目文档中保存提交 SHA、命令、版本、通过/失败/未运行项和必要的无敏感信息证据。CI artifacts 有保留期限，不是唯一长期交接材料。

## 云环境配置与 Android 边界

用户可在保存环境的初始化步骤中配置 `python3 scripts/cloud-env.py setup`，并在每次任务中显式使用 `python3 scripts/cloud-env.py run ...` 或 `verify`。仅创建目录或生成 PATH 不会自动配置后续任务；本脚本不改平台的保存设置。系统库若需预装，由获授权的环境配置者安装；之后 `check` 必须通过。

Android 单元测试及无签名诊断 APK 继续由 `.github/workflows/ci.yml` 执行。云网页任务不运行 `build:android`，不加载 `GLEAM_KEYSTORE_*` 或本地签名属性；Gradle 配置本身也可能尝试读取这些材料。原证书签名、正式发布和真机验收保持单独授权，不把网页全绿等同 Android 或发布全绿。

## 完整历史敏感信息检查

main与preview的CI先运行history_secrets，通过后才开始网页、浏览器或Android任务。checkout使用fetch-depth:0，并把远端heads、tags和PR head获取到独立refs/audit命名空间；当前PR测试合并提交也由Git refs一并覆盖。e2e与upgrade_cache固定ubuntu-24.04，避免ubuntu-latest的发行版迁移破坏当前Playwright支持范围。

CI的e2e使用4片矩阵，向协调器传入`--shard-index 1..4 --shard-count 4`，将完整脚本列表稳定轮转分配，失败不取消其他片；截图artifact按片区分，演示截图仅片1生成。直接执行`npm run test:e2e`仍为全量顺序执行。分片参数无效或会产生空片时，在启动服务前报错；协调器单测检查完整覆盖、失败传播和服务清理。

Linux x86_64可从仓库根目录运行：

```sh
python3 scripts/check-history-secrets.py
python3 scripts/test-history-secrets.py
```

本地入口只扫描已有完整refs，不自动fetch，也不修改HEAD／分支；可用`--repo`指定完整镜像。Gitleaks固定8.30.1，下载归档和可执行文件均核验固定SHA-256，缓存于`.tmp/tools/`；不执行未经核验的缓存。工具、配置、报告或网络异常返回失败，浅克隆直接拒绝，不降级为只查当前文件。

规则采用固定工具内置默认值，禁止仓库配置、环境变量或inline allow静默放宽；`.gitleaksignore`只接受两条已核实的历史APK SHA-256误报fingerprint，新增条目需要同步修改并审核工具策略。除历史文本变更（含merge和删除）外，也检查提交／注解tag说明及禁止提交的历史路径。真实临时Git测试运行时生成无效合成凭据，不调用服务或写入产品数据。

诊断仅包含路径、规则、提交及行号；原始进程输出不回显，临时报告不上传Actions artifacts。该检查不验证凭据在线有效性，也不能识别任意自定义加密／隐写；历史二进制和公开发行附件仍需按实际内容另行审计。

## 后续任务交接

1. 先读 `AGENTS.md`、`docs/PROJECT_STATUS.md`、本文件，再读相关功能与测试说明；用户本次授权优先于旧任务措辞。
2. 核验仓库身份、实际可见性、远端 main 与当前 HEAD、分支、工作树及任务目标。平台可能把 main 内容检出到名为 `work` 的分支，不应把分支名等同提交来源。
3. 云环境默认仍绑定 main。处理本地预览反馈或新增功能时，先 fetch `origin/preview/orbstack`，从其最新提交继续或建立短工作分支，保留待验收改动；该分支不视为正式基线，不改保存环境的默认绑定。main 前进时可整合到预览，实质冲突先询问用户。持续语音暂缓，不能借环境维护扩大范围。
4. 用可重建流程准备依赖；提交前记录实际检查，不复用其他 SHA 的通过结论。草稿 PR 的普通 CI 需核对 head/测试合并提交及每个 job；无权限启动或读取时报告具体阻碍。
5. 用户于 2026-10-12 持续授权：修改和新增功能通过相应检查与敏感信息扫描后，直接正常推送到 `preview/orbstack`，无需每次再请求批准；核对远端精确 SHA 和同一提交的 `Preview checks` CI。推送冲突或 CI 失败应继续诊断，不能强制覆盖或标记为成功。合入 main 和正式发布仍需单独批准。
6. 交接写明 PR/分支/精确 SHA、改动、已运行与未运行验证、CI 链接和已知限制。用户自行在本机拉取预览分支到 OrbStack 并反馈网页验收；Cloud 检查不代替此验收，不得宣称已合并、已发布或长期迁移完成。

当前发布基线和待办以 [项目状态](PROJECT_STATUS.md) 为准。
