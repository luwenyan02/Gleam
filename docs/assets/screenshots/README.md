# 界面预览来源与更新

本目录只保存项目介绍用的真实应用截图，不保存用户截图、真实账目或测试失败画面。

## v1.8.0 预览

- 应用版本：`1.8.0`，应用源码与[发布提交 `8707ddc`](https://github.com/luwenyan02/Gleam/commit/8707ddc40cf308dbdbbb687bb75cf0ef573294f5)一致；这次更新只修改介绍、截图及其生成流程。
- 捕获日期与提交：2026-10-02，[`b56b509`](https://github.com/luwenyan02/Gleam/commit/b56b509d9f8e952770652a5a7c1d6dcba638d4a6)。[完整 CI 与截图日志](https://github.com/luwenyan02/Gleam/actions/runs/36987835424)通过了全部回归和 28 张截图；[原始 artifact](https://github.com/luwenyan02/Gleam/actions/runs/36987835424/artifacts/11218379049)按 CI 策略短期保留，本目录中的选定 PNG 长期保存在 Git 中。
- 捕获工具：Playwright Chromium，运行 `npm run build` 的网页生产构建，没有重绘、拼接或修改界面像素。
- 数据：每种宽度使用全新的浏览器上下文与虚构数据库；演示时间固定为 `2026-10-02 12:00 Asia/Shanghai`，便于复现。周刊中的上周日期同样属于演示数据。
- AI：聊天流式回复与周刊内容由本地测试夹具提供；请求不发送给真实服务，图片中的内容不代表真实模型的质量验收。除测试应用来源外的非模拟网络请求一律阻止。
- 布局：生成 360、390、430、1280px 四种宽度，每张高 844px；README 选用 390px 原图，点击可查看完整尺寸。
- 范围：首页、账户、报表、拾光时间流、AI 聊天、拾光周刊、借贷。每次截图等待页面内容、提示消失和动画稳定，并检查横向溢出及浏览器错误。
- 平台：这些是网页界面截图，不是 Android 真机截图，也不替代安装、输入法、系统返回、读屏或手机备份恢复验收。

本目录七张 PNG 均与上述 artifact 中 `e2e/readme/390/` 的文件逐字节相同，已检查实际画面与尺寸；校验值见 [`SHA256SUMS`](SHA256SUMS)。

## 复现

在 `app/` 目录安装依赖与 Playwright Chromium 后运行：

```sh
npm run build
npm run test:e2e
```

完整回归保留原有 35 个套件，结束后单独运行 [`capture_readme.py`](../../../app/e2e/capture_readme.py)。脚本复用测试预览服务，输出到仓库根目录 `.tmp/tests/e2e/readme/<宽度>/`，不直接覆盖本目录。CI 的浏览器截图 artifact 同时保留这组图片。

如已启动独立测试预览服务，也可只运行截图流程（不占用日常 5173 预览地址）：

```sh
GLEAM_E2E_URL=http://127.0.0.1:4617/ python3 e2e/capture_readme.py
```

发布新预览时先逐张查看实际图片，确认页面完整、文案与版本一致、无真实数据、无浮层遮挡，再从 `390/` 复制选定 PNG 到本目录。同步更新来源提交、捕获日期和校验值；不得用历史图加上新版本标签，或用生成图冒充应用截图。
