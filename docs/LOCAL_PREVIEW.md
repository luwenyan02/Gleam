# OrbStack 本地常驻预览

固定入口：<http://localhost:5173/>。保持该地址和原浏览器，账本、设置和聊天草稿仍使用原来的 IndexedDB；`127.0.0.1`、不同端口或 `orb.local` 都是不同来源，不会自动共用数据。不要清除站点数据来解决连接问题。

项目根目录执行：

```sh
sh scripts/preview-local.sh up
sh scripts/preview-local.sh status
sh scripts/preview-local.sh logs
# 仅在需要主动停用时：
sh scripts/preview-local.sh stop
```

`up` 只构建并启动本项目的 `gleam-preview` Compose 服务，不推送镜像、不修改其他容器。启动后无需保留终端或 Codex 会话。容器设置 `unless-stopped`，OrbStack 重新启动后恢复；手动 stop 后需要再执行 up。Mac 关机、睡眠或 OrbStack 退出期间不能访问。若需要登录后自动恢复，请保持 OrbStack 的登录启动选项开启。

## 修改后如何更新

- `app/src`、`app/public`、`app/server` 挂载本地目录，源码、样式、图片修改直接反映到预览，Vite 热更新支持的部分自动刷新。其余变化刷新网页即可。
- `package.json`、`package-lock.json`、vendor 依赖、部署配置和环境变量变化后，重新执行 `up`。安装依赖来自 lockfile；Linux 依赖与本机 node_modules 隔离。
- Vite/TypeScript 配置和 index.html 以单文件挂载；若编辑器以文件替换方式保存，执行 `up` 重新挂载。更改挂载清单也执行 `up`。
- 本地服务不等于正式生产发布。构建、单测和相关浏览器验收仍需照常进行。

## 网络与语音

采用 [OrbStack host networking](https://docs.orbstack.dev/docker/host-networking)，Vite 只监听 `127.0.0.1:5173`，没有公网发布、没有 `0.0.0.0` 监听。主机网络与其他 host-network 容器共享，因此不能同时再启动另一份占用 5173 的预览。

实时语音保留原有回环地址、同源和请求头校验，不放宽成任意私有网段。`DASHSCOPE_API_KEY` 从启动命令所在终端环境传入，仅在容器服务端使用；容器运行/重启保留创建时配置，更换 Key 后需带新环境执行 `up`。不要运行会完整打印环境变量的 `docker inspect` 或 `docker compose config` 并分享输出。业务空间等本地设置通过 Git 忽略的 `app/.env.local` 读取。

镜像构建上下文使用白名单，只包含依赖清单、vendor 包和 Dockerfile，不包含源码之外的账目、截图、密钥、Android 签名材料。运行时只挂载必要应用目录，不挂载整个仓库或用户主目录。

## 排错

先执行 `status`，等待 `healthy`，再刷新。失败时看 `logs`：端口占用不要直接杀未知进程；依赖变化执行 `up`；OrbStack 未运行先打开 OrbStack。不要清理 Docker 全部镜像、其他容器或浏览器账本。
