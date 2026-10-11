# Android 升级缓存能力探针

状态：原生底层清理路径已取得限定可行性证据；生产启动修复尚未验收。PR #15 保持草稿，不可据此合并或交付缓存修复。

## 已验证环境与提交

- 探针提交：`aa7329c59e17acea3bdf0385b12cfc5aae62e383`
- 原生运行：[38153755557](https://github.com/luwenyan02/Gleam/actions/runs/38153755557)，job `114512358278`，2026-10-11 16:07 UTC 成功，`OK (1 test)`。
- 证据 artifact：`11708170351`，包含 instrumentation 输出、模拟器和 WebView 版本；CI artifact 仅短期保留，源码断言及此记录保留在仓库。
- 官方 Android Emulator `37.2.12`（build `16428233`），Android 35 Google APIs x86_64 系统镜像。
- 本次 artifact 读回 WebView：`com.google.android.webview 124.0.6367.219`。实际提供者版本已从本次 artifact 独立读回，不能推定所有 Android/WebView 实现相同。
- 隔离 GitHub runner；稳定 SDK 条款与已批准的 2019-01-16 文本归一化 SHA256 匹配。仅该临时 runner 用户获既有 kvm 组访问，设备权限保持 660。
- 无真实服务请求、用户 Key、账目或录音。探针内 WebView/ServiceWorker 请求均用内存响应拦截；Keystore 值为新建虚构哨兵。

## 实际断言

1. 安装合成 root `/sw.js`，等待完整激活及控制器建立。
2. 新导航加载旧缓存页面，证明旧应用脚本确实能够执行；旧页面静态 DOM 标记与当前页面不同。
3. `loadDataWithBaseURL("https://localhost/", …)` 具有安全上下文、同源 localStorage 和 serviceWorker 对象，但 `getRegistrations()` 抛出 `InvalidStateError`，探针明确记录 `no-provider`。它不能被当作无 worker，亦未被用来打开生产页面。
4. 另建无 Bridge 的 WebView，加载正常 `https://localhost/` 导航导航期间禁用 JavaScript。原生 `onPageFinished` 后尝试在禁用状态执行 `evaluateJavascript("1+1")`，实际返回 `null`，不能作为清理通路；随后启用脚本执行受控清理。
5. 检查它确实收到旧 DOM，且 controller 指向旧 `/sw.js`。inline、module、external、onload、onerror、timer 和 SVG SMIL 七类旧脚本有已验证的启用基线 `[1,1,1,1,1,1,2]`。重新启用 JavaScript 后等待 1500ms，计数均不增加；清理及新页面加载后仍不变。SVG 夹具包含 0 秒和 1 秒开始事件，不是仅检查同步解析器脚本。
6. 要求恰好一个拥有的根注册，核验 active/waiting/installing 的脚本 URL，注销并重新枚举确认消失，然后销毁清理 WebView。
7. 新 WebView 导航收到新页面；合成 IndexedDB、localStorage 原值保留，已有 Android Keystore 密钥仍可解密原哨兵。

测试成功证明上述夹具及运行版本下的机制可行，不等于真实 APK 覆盖安装、所有提供者兼容或完整应用启动验收。

## 尚待验证

- 候选主 WebView 导航闸门与同步 Bridge 初始化的实际 Android 编译、安装运行。
- 保存状态、Activity 重建和真正的进程死亡恢复；原生 Activity/权限结果与分享/深链事件不丢失、不重复。
- 失败、重试、暂停/恢复、迟到回调及跨 Activity 全局 worker 拦截器所有权。
- 精确历史 APK 网页资源与当前资源的升级，而非只用最小合成页面。
- 更多受支持 Android/WebView 提供者；用户手机实际覆盖安装验收。

禁止为使测试通过而清空应用数据、改源、删除 IndexedDB/localStorage/Keystore，或把网页浏览器测试当作 Android 生命周期测试。
