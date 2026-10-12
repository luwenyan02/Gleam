import type { Plugin } from 'vite';

// An old static PWA may intercept navigation before the Vite entry can run.
// Updating its own /sw.js retires that registration, then loads live source.
// No storage or caches are deleted. Production builds keep the normal worker.
const retirementWorker = `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  await self.registration.unregister();
  const windows = await self.clients.matchAll({type: 'window'});
  await Promise.allSettled(windows.map(client => client.navigate(client.url)));
})()));
`;

export function previewWorker(): Plugin {
  return {
    name: 'gleam-preview-worker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' || request.url?.split('?')[0] !== '/sw.js') return next();
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Service-Worker-Allowed', '/');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(retirementWorker);
      });
    },
  };
}
