# Codex Cloud → OrbStack 一键预览

固定入口：<http://localhost:5173/>。保持该地址和原浏览器，账本、设置和聊天草稿仍使用原来的 IndexedDB；`127.0.0.1`、不同端口或 `orb.local` 都是不同来源，不会自动共用数据。不要清除站点数据来解决连接问题。

## 首次初始化（只做一次）

专用分支是私有仓库 `luwenyan02/Gleam` 的 `preview/orbstack`，用于尚未合入 main 的预览改动；云环境默认绑定仍为 `main`，正式基线不变。用户于 2026-10-12 已持续授权 Cloud 端在验证通过后直接正常推送到此预览分支，无需每次重复批准；每次交付核对远端 SHA 和对应 `Preview checks` CI。合入 main 或正式发布仍需单独批准。

1. 打开 OrbStack，解压 `gleam-orbstack-sync.zip` 到固定目录。
2. 本机需要 macOS Git 和此私有仓库的读取权限。现有 Git 凭据可以复用；Cloud 的登录不会传到 Mac，首次没有权限时脚本会停止并提示。安装 Git 可用 macOS Command Line Tools；**不需要本机 Node、npm 或 Python**。
3. 双击 `更新拾光预览.command`。首次下载源码到包内独立的 `checkout/` 并构建容器，成功后打开 <http://localhost:5173/>。
4. 使用原来的浏览器和原来的地址确认账本。首次从静态 PWA 切换时，开发服务器提供退出旧 worker 的脚本，可能自动刷新一次；它不删除 IndexedDB、localStorage 或账本。开发预览不安装离线 worker。

首次下载完成后不要移动或覆盖这个目录；Docker 挂载依赖它的位置。原有 `gleam-preview` 项目的 `web` 容器会由新 Vite 服务接替。若 5173 被其他程序占用，脚本停止，不杀未知进程。

包内不包含 GitHub Token、AI Key 或账目。默认使用 HTTPS Git；需要 SSH 时，首次从终端设置 `GLEAM_PREVIEW_GIT_URL=git@github.com:luwenyan02/Gleam.git` 运行 bootstrap，之后双击会自动复用初次选择的来源。来源保存在此专用检出的 Git 配置中；不要把 Token 写进 URL。脚本不修改 Git 凭据、全局 Git 配置或用户 shell 配置。

## 后续每次验证

Cloud 修改验证通过、推送 `preview/orbstack` 并核对 CI 后，双击同一个 **更新拾光预览.command**。已有标签页通过 Vite 更新；必要时刷新页面。无需重新下载 ZIP、复制 dist 或重装容器依赖。也可自行在专用预览检出中拉取此分支，再用启动助手更新；依赖变化执行 `up`，单文件挂载变化执行 `reload`。本机验收结果由用户反馈。

- 普通源码、CSS、public 和 server 目录修改：快进 Git，复用容器与镜像，使用 Vite 热更新；部分 server/模块变化需要网页刷新。
- 依赖清单、lockfile、vendor、Dockerfile 或构建上下文变化：重建依赖镜像并重新创建容器。
- Vite/TypeScript 配置、index.html、Compose 或启动助手变化：重新挂载并启动容器，复用依赖镜像。
- Git 网络或权限失败、本地未提交/未跟踪文件、分支分叉或远端回退：停止同步并保留当前预览。不会 reset、clean、覆盖本地改动或强制更新分支。

更新前保存已跟踪源码快照到 `checkout/.tmp/preview-sync/backups/`，并用本地 Git 引用保留提交；上一版容器镜像保存为 `gleam-preview:backup-<SHA>`。脚本不修改 Git 忽略的 `app/.env.local`，不挂载浏览器数据。

首次成功启动后，后续更新若启动失败，会在 `preview-recovery/...` 分支恢复上一版源码和缓存镜像；新提交仍保留在 `preview/orbstack`。双击 **回退上一预览.command** 也能恢复上一版。恢复只回退代码和镜像，不回退浏览器数据或数据库迁移；今后涉及不兼容数据迁移时，必须单独设计数据恢复，不能宣称可无损回退。

恢复后，若远端仍是被拒绝的版本，点击更新会继续使用恢复版；远端出现新提交时才重试。首次安装没有成功版可恢复。不要清除备份镜像或源码目录来排错。

开发者也可在专用 `checkout/` 根目录运行：

```sh
sh scripts/preview-sync.sh update
sh scripts/preview-sync.sh rollback
sh scripts/preview-sync.sh status
```

手动管理服务（`up` 会主动重建，日常更新使用上面的 sync）：

```sh
sh scripts/preview-local.sh up
sh scripts/preview-local.sh status
sh scripts/preview-local.sh logs
# 仅在需要主动停用时：
sh scripts/preview-local.sh stop
```

`up` 只构建并启动本项目的 `gleam-preview` Compose 服务，不推送镜像、不修改其他容器。启动后无需保留终端或 Codex 会话。容器设置 `unless-stopped`，OrbStack 重新启动后恢复；手动 stop 后需要再执行 up。Mac 关机、睡眠或 OrbStack 退出期间不能访问。若需要登录后自动恢复，请保持 OrbStack 的登录启动选项开启。

不要直接在专用 checkout 中开发；本地开发用其他检出目录，避免阻塞更新。停止/重启 OrbStack 或刷新网页不会主动删除账本；不同浏览器或浏览器 profile 仍是独立数据空间。本地服务不等于正式生产发布。

## 网络与语音

采用 [OrbStack host networking](https://docs.orbstack.dev/docker/host-networking)，Vite 只监听 `127.0.0.1:5173`，没有公网发布、没有 `0.0.0.0` 监听。主机网络与其他 host-network 容器共享，因此不能同时再启动另一份占用 5173 的预览。

实时语音保留原有回环地址、同源和请求头校验，不放宽成任意私有网段。`DASHSCOPE_API_KEY` 从启动命令所在终端环境传入，仅在容器服务端使用；容器运行/重启保留创建时配置，更换 Key 后需带新环境执行 `up`。不要运行会完整打印环境变量的 `docker inspect` 或 `docker compose config` 并分享输出。业务空间等本地设置通过 Git 忽略的 `app/.env.local` 读取。

双击启动器不会继承另一终端的环境变量；需要私有 AI/语音配置时，可在 `checkout/app/.env.local` 中保存服务端配置并手动执行一次 `up`。此文件不上传，也不进入构建上下文。

镜像构建上下文使用白名单，只包含依赖清单、vendor 包和 Dockerfile，不包含源码之外的账目、截图、密钥、Android 签名材料。运行时只挂载必要应用目录，不挂载整个仓库或用户主目录。

## 排错

先执行 `status`，等待 `healthy`，再刷新。失败时看 `logs`：端口占用不要直接杀未知进程；依赖变化执行 `up`；OrbStack 未运行先打开 OrbStack。不要清理 Docker 全部镜像、其他容器或浏览器账本。

若窗口提示锁仍存在，先确认没有正在更新的 Terminal 进程，再移除对应 `.bootstrap-lock` 或 `checkout/.git/gleam-preview-sync.lock`；不要在更新中删除锁。容器健康检查验证 HTTP 能响应，应用操作仍需浏览器验收。

## 脚本验证

```sh
# 真实本地 Git + Docker 命令替身，不联网、不推送 GitHub
python3 scripts/test-preview-sync.py
# 可选：Linux Docker + Chromium，独立端口和合成账本；不连接用户浏览器
PLAYWRIGHT_BROWSERS_PATH="$PWD/.tmp/cloud-env/browsers" \
  .tmp/cloud-env/python/bin/python scripts/test-preview-live.py --context default
```

真实 Docker 检查会建立和清理它自己的临时项目，并验证旧 PWA 切换、CSS 热更新、容器复用、依赖重建和构建失败恢复。Cloud 的公开代理 CA 仅通过 BuildKit secret 在安装依赖时读取；不写入镜像，TLS 校验保持开启。macOS OrbStack 与用户原浏览器账本仍需首次本机验收；Cloud 检查不能替代该验收。
