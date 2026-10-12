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

- 权限 pending result 确实进入保存 Bundle 后，新实例的回调交付与原调用保留程度；区分 Capacitor 既有行为及闸门差异。
- 最终提交上的完整生命周期、真正进程死亡及浏览器 PWA 自动更新/离线回归；不同提交的通过项不拼成未经重跑的全绿。
- 独立最终代码审查，尤其是失败/重试、全局 worker 所有权及旧文档脚本边界。
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

## `53ccbc` 覆盖安装与历史资源实测

提交 `53ccbcddd48117ab34cfb7788061e144b6158586`，原生运行 [38157633775](https://github.com/luwenyan02/Gleam/actions/runs/38157633775)：

- 覆盖安装 job `114523775043` 于 2026-10-11 17:05 UTC 成功。旧包种子测试和覆盖后核验各 `OK (1 test)`；三包 SHA256、唯一同一 debug 签名及版本先核验，再执行无清数据的 `adb install -r`。
- 源夹具 `1.10.5/11005` → 当前 `1.11.0/11100`。旧受控文档确实来自旧缓存，模块路径为原始旧值；DOM 未 mount、主题脚本未运行、无 Android Bridge/Capacitor 对象。新页面模块为当前值、旧控制器已消失、根注册为 0。
- 合成账目哨兵 localStorage、独立 IndexedDB、真实 GleamDB 设置中的主题、原生 SharedPreferences 与 Android Keystore 解密值保持；实际旧缓存 HTML 的 SHA256 亦保持，未清空缓存来使测试成功。
- artifact `11709511937` 已读回，ZIP SHA256 `d7fa9b196a6f725cc724887de290b4ade8d9af9bc8e85ab9ac309b26674ddff1`，提供者为 `com.google.android.webview 124.0.6367.219`，Android 35。此证据仍只覆盖自产 debug 夹具，不证明历史正式 native APK 签名兼容。
- 同次 lifecycle job `114523775456` 中，原始能力探针、精确历史资产单 APK 升级、导航闸门、Bridge/Bundle、分享/深链、失败重试、子 Activity 结果与合成数据/Keystore测试通过。
- 该 lifecycle job 总结果为失败：修正后的权限恢复探针在未加闸门的 baseline 就未观察到新 Activity 回调，gated 对照尚未执行。正在区分 Android 保存 Bundle 时机与底层恢复行为；不能宣称权限恢复已通过，亦不能把基线失败归因于闸门。其后的真正进程死亡阶段未运行。
- 同提交普通 CI 的 Web 单测（79 文件 / 1,081 项）、离线 AI 评估（242/242）、Android 单测与编译、浏览器精确旧资源升级诊断通过；完整浏览器回归于 17:19 UTC 成功，其中新 PWA 测试确认真实 worker 自动更新刷新、离线重载，以及模拟原生连续重载零注册。后续文件修改不得继承此提交未重跑的证据。

权限失败诊断的源依据：[Android 15 ActivityThread.callActivityOnStop](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/core/java/android/app/ActivityThread.java#L5323-L5346) 在 target >= P 时先 onStop 再保存，并在已有 r.state 时不重新保存。旧探针在 moveToState(CREATED) 返回后才注入，可能错过实际保存。当前修正把注入放入 onActivityStopped，新增 onActivityPostSaveInstanceState 实际 Bundle 与新 registry 同 key 断言；没有手写替换 saved Bundle，也未放宽一次回调或接收者身份检查。修正运行尚待下一提交。

## `27029a8e` 保存证据诊断

提交 `27029a8e6eb7e69115db40cac611b4af626c1213`，原生运行 `38159309270`：覆盖安装 job `114528697205` 再次成功（artifact `11709901012`，ZIP SHA256 `221a3d9645484274dcdca88ff361dd5c40384c004a01a699ab480ebada4c12c6`）。lifecycle job `114528697297` 的能力探针、精确历史资源及其他六项通过，但权限 baseline 在“实际保存 Bundle 含 pending”前置断言失败。该断言此前未区分框架保存回调未发生和 Bundle 缺 key，因此不能称为已证实的框架/Capacitor 丢回调，也不能称为时序修复已成功。

下一版不再猜测调整注入时机，新增 debug-only 完整事件观察：Activity 身份、Application/AndroidX 生命周期、实际 onSaveInstanceState entry/after-super、pre/save/post 次数、真实 Bundle 的 key/type 树与 pending registry（仅合成键与类型，不输出数据值）。分别运行 baseline/gated 并保留失败，不手写或替换框架 Bundle。原生 driver 将六项一般生命周期测试和真实 PID-kill 恢复放在权限诊断之前；权限诊断单独运行并继续决定整个 job 失败，避免遮挡独立证据。

## `1bdcf028` 实际事件顺序与进程恢复

提交 `1bdcf028d6efbd274a4094202abf7525d7ab91a6`，运行 `38160925629`。lifecycle job `114533478839` 已依次通过能力探针、精确旧资产、六项生命周期和实际 PID-kill 恢复。后台原进程 `4164` 被终止，前台结果进程 `4283` 保持，恢复宿主与回调进程均为 `4822`；原 Bundle、原生插件状态、调用参数、dangling call 保持，闸门关闭时接收回调，Activity 回调及 App restored event 各一次。artifact `11710717298` 已读回，ZIP SHA256 `ec102083bae1810edab763add9007c447e04fd43d3d101952be70eddc9bcc102`。

该 job 仍失败于独立权限诊断。完整 trace 给出可核验的顺序：baseline moveCreated 返回时 `postSave=0`，测试在 +2892ms 立即断言失败；真实 after-super 在 +2930ms、postSave 在 +2936ms 均包含原 pending key。gated 同样在 +1922ms 返回，而 +1929ms 保存后含 key。由此明确是“测试在真实保存完成之前检查”的竞态，不是框架未保存，更不能归因于缓存闸门或 Capacitor 回调恢复。下一修正仅通过有界同步等待真实 postSave 完成后才检查和重建，注入位置不变；实际回调交付仍待新运行，不预判通过。

同提交覆盖安装 job `114533479057` 成功，artifact `11710711079`，ZIP SHA256 `176c722258695a079146e66ea83ce94b9e61e30731b5fea65ee2f601c13a4d61`。不同阶段结果保留各自范围，不因覆盖安装或进程恢复成功将权限诊断标绿。

同提交普通 CI `38160925638` 的完整浏览器回归失败于既有凭证测试 `test_entry_receipts.py:92`：保存后立即读取九张凭证卡片的渲染宽度，未达到原 144px 断言。此前相同 Web 源码的两轮完整回归通过；本次没有记录具体尺寸，不能断言确切根因。PWA 自动更新/离线/原生零注册测试均通过。测试现等待当前详情九张凭证的几何稳定及祖先动画结束，再同时核对 computed/layout/rendered 宽度；144px 要求保留，仅 DOMRect 浮点误差允许 1e-6px，并输出实际尺寸及失败截图。未改生产凭证布局，修正的实际浏览器结果仍待下一轮。


## 1.11.1 私有候选准备

修复基线 `a13a5c66c399abf0e83cb412472e174bd6ce66d9` 的普通 CI `38162746167` 四组与原生 `38162746134` 两组全部成功；独立审查及 artifact 读回允许进入私有手机候选。原生 artifact `11711575406`（SHA256 `66dbd93f272264e25261d9658f2fbb654da79c9f7c7f0e05dfc8c85f6ef7eb39`）核验真实保存 Bundle、新 registry 和新 Activity 一次回调，baseline/gated 原 PluginCall 均为 null；它只证明所测路径没有退化，不是完整权限调用恢复。实际 PID-kill `4260`、存活结果进程 `4360`、恢复/回调 `4876`，原状态和 Activity/App 事件各一次均通过。覆盖安装 artifact `11710838365`（SHA256 `cdf8dc3d1a705acb756bd02244c34463852eaab881d3238936e5f09956f8923a`）通过，不代表历史正式签名兼容。

本次仅提升版本为1.11.1/11101并更新候选说明，不改变已验证生产逻辑。新精确 head 必须完整复测、核验非debug release APK与原签名和全部网页资源后才能本会话交付。当前不合并main或正式发布；候选CI、包SHA和手机验收结果分别记录，不继承尚未运行的通过结论。
