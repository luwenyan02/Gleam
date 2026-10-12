import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { voiceBridge } from './server/voiceBridge';
import { previewWorker } from './server/previewWorker';

const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    previewWorker(),
    voiceBridge(loadEnv('development', process.cwd(), 'DASHSCOPE_').DASHSCOPE_WORKSPACE_ID),
    {
      name: 'gleam-build-info',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ version: appVersion }) });
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      // Native WebViews use packaged assets; only browsers should install the PWA worker.
      injectRegister: false,
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: '拾光',
        short_name: '拾光',
        description: '本地优先的记账与生活记录应用',
        lang: 'zh-CN',
        theme_color: '#F6F7F9',
        background_color: '#F6F7F9',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Explicit because disabling injected registration also disables plugin autoUpdate defaults.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
      },
    }),
  ],
});
