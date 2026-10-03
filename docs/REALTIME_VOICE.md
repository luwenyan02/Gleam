# 本地网页版实时语音

入口：拾光 → 和拾光聊聊 → 输入区“语音聊”。

本页仅说明开发网页版生活实时聊天。Android 独立 Key 的单句记账入口见 [手机短语音记账](SHORT_VOICE_ENTRY.md)，两者的鉴权、数据边界和保存流程分开。

本版通过浏览器 WebRTC 传输声音，Vite 本地中转只负责 SDP 建连鉴权。没有新增账号体系，不读取账本或已有聊天，不保存音频文件；返回的转录保留在当前本地会话，用户选择“整理”并确认草稿后才保存为正式记录。重新开始语音不会自动发送之前的文字上下文。

## 启动

日常预览使用 [OrbStack 常驻服务](LOCAL_PREVIEW.md)，根目录执行 `sh scripts/preview-local.sh up`；不必每次手动开启下面的临时 Vite 服务。两种方式不要同时占用 5173。

在启动 Vite 的终端环境中设置 `DASHSCOPE_API_KEY`，然后在 `app/` 执行 `npm run dev -- --host 127.0.0.1 --port 5173`。不要把 Key 写入源文件、VITE_ 环境变量或提交到 Git。

在语音面板选择地域、模型，填写该 Key 所属的百炼业务空间 ID。也可通过服务进程的 `DASHSCOPE_WORKSPACE_ID` 环境变量提供默认 ID，或在 Git 忽略的 `app/.env.local` 中设置该 ID（不是 Key）。更换进程环境变量后须重启 Vite。

支持配置 `qwen3.8-omni-flash-realtime`、`qwen-audio-3.1-realtime-plus` 和 `qwen3.5-omni-plus-realtime`。普通 `qwen3.5-omni-plus` 不是本版实时接口的模型名。是否有调用权限，以账号和对应地域实际返回为准。

点击“同意并开始语音”后才申请麦克风权限。可静音、打断、结束；关闭面板、切到后台或连接失败会释放麦克风。本地连接超时 30 秒，单次语音最多 5 分钟，可主动重新开始。转录可能不准确，请在正式保存前核对。

## 范围与安全

- 中转仅接受回环地址、同源页面和指定请求头；出站固定为百炼专属域名，不支持任意 URL 转发。
- Key 只留在 Node 进程，浏览器不接收 Key。错误不回显远端正文；不记录 SDP、语音或转录日志。
- 此服务仅在 Vite 开发模式启用，生产构建、离线 PWA 和 Android 安装包尚不包含中转。不要将开发服务器暴露到公网。
- 文本聊天仍使用应用设置中的平台和模型；语音目前独立使用本机百炼配置。
- 原始会话全部留在本机；文字聊天发送最近最多 30 条且约 22000 字符的上下文，不自动发送其他记录。整理仍受单次素材长度限制。

接口依据：[百炼 Realtime 指南](https://help.aliyun.com/zh/model-studio/realtime)、[Realtime API 概述](https://help.aliyun.com/zh/model-studio/realtime-api-overview)、[Qwen-Audio 实时语音](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)。
