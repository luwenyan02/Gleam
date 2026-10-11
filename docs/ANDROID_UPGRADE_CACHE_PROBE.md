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

## 首轮生产候选生命周期证据

- 提交 `44f7288978387a18d920835ad0a42f24524cbbff`，运行 [38154622179](https://github.com/luwenyan02/Gleam/actions/runs/38154622179)，artifact `11707933102`，2026-10-11 16:20 UTC 成功。
- Android Gradle 实际编译 debug 主 APK 与测试 APK；生成配置核验 `android.resolveServiceWorkerRequests=false`。
- 原始能力探针 1 项、主导航/Bridge 集成 7 项、外部实际进程死亡核验 1 项通过。
- 七项包括构造即关闭的导航/脚本入口、同步 Bridge 与 Bundle 重建、冷分享/深链原生事件一次保留、失败重试与迟到回调、真实子 Activity 结果跨宿主重建、合成权限结果基线对照、合成旧 worker 清理及 IDB/localStorage/Keystore 保留。
- 真正进程死亡阶段：前台结果 Activity 在独立 PID `4226`；杀死后台宿主 PID `4119` 后确认旧进程消失且结果进程存活。系统返回结果时宿主新 PID 为 `4728`，与回调 PID 相同。原 Bundle、插件状态、原调用参数和 dangling call 均恢复；回调发生时主闸门关闭；Activity 回调及 App restored event 均恰好一次。
- 权限诊断复核发现夹具假阳性：ActivityScenario.recreate() 先恢复旧 Activity，原实例在销毁前已收到 pending result，静态记录随后仍在。baseline/gated retained=true 仅为旧实例停止→恢复路径的基线一致性，不能计为权限调用跨重建保存；该门槛仍未关闭，需核验回调接收者为新 Activity。真实麦克风授权弹窗和权限结果跨进程死亡亦未测试。
- 测试使用 debug-only HTTP/WebDAV/speech 拒绝适配器，保留实际 MainActivity/Bridge/AndroidX 和合成结果插件路径。不能据此宣称真实语音插件/服务恢复已验证。
- artifact 独立读回提供者仍为 WebView `124.0.6367.219`，Android 35。后续新增历史资源夹具及网络 document-start 限制不在此提交证据内。

后续 `c19ce5e2e654b0a870b5bf1a07738f8fc0a639b7` 历史资产扩展首次编译发现测试代码直接引用 AndroidX WebKit 缺少直接 debug 依赖；该次并未运行模拟器，不继承前一提交的全绿结论。

## 原生不再新建 PWA worker

精确旧资源扩展在 `08902bc`（运行 `38156209363`）已走过旧 DOM 无脚本、当前页面与存储保留断言，但最终 root 注册数量期望 0、实际 1。现有 Vite PWA 注入脚本仍无条件注册 worker；之前较早的数量检查存在时序漏洞，不能把原生永远没有新注册当作既有事实。

候选现在关闭无条件注入，改为仅 `!Capacitor.isNativePlatform()` 时手动注册 PWA，并明确保留浏览器 `skipWaiting` / `clientsClaim` 自动更新行为。旧原生根 worker 仍由同源启动闸门迁移清理。原生零注册断言保留，不用放宽断言掩盖问题。

此项本地通过 3 项新单元测试、完整 1,073 项单元测试、类型检查及构建。新增浏览器真实自动更新/离线回归与 Android 端最终运行尚待 CI；本地现有 Chromium 因操作系统 UNIX socket EPERM 未启动，未宣称浏览器通过。

覆盖安装夹具使用同包名、全新测试专用 debug 签名的两个自产 APK。旧包中 28 个原始网页资源逐个校验，原生部分为当前测试夹具；先保存实际缓存 HTML 摘要与合成状态，再 `adb install -r` 更新，不清数据或卸载。新包核对包版本、同一签名、旧缓存页面不执行、新页面及 IDB/localStorage/原生偏好/Keystore 保留。它不证明历史正式 native APK 或用户签名兼容。首次已构建两包，签名校验脚本因工具实际输出 `V2 Signer:` 而未接受；解析已按实际输出修正，仍核验唯一签名、全新测试公钥、包名/版本/debug 标记及 instrumentation 目标，没有跳过签名核验。
