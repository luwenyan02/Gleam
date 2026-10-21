import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.gleam.shiguang',
  appName: '拾光',
  webDir: 'dist',
  // Capacitor debug 默认会打印原生调用参数；所有构建关闭桥日志，避免 setKey 泄漏。
  loggingBehavior: 'none',
  // Native boot guard owns the process-wide worker client from before Bridge construction.
  android: { resolveServiceWorkerRequests: false },
  // 安全区：Capacitor 8 内置 SystemBars 插件默认 insetsHandling='css'，
  // 配合 index.html 的 viewport-fit=cover，env(safe-area-inset-*) 行为与 Web 一致，无需额外配置
  plugins: {
    // [R06] 云备份直连：原生端 fetch 经 CapacitorHttp 转发，绕开 WebView CORS 限制
    CapacitorHttp: { enabled: true },
    // AI SSE 独立按需读流；测试网络隔离可显式关闭，不改变其它 HTTP 通道。
    GleamAiStream: { enabled: true },
  },
};

export default config;
