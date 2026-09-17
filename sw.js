/* Service worker: caches the app shell so the web version works offline.
   App files are network-first (so updates land), fonts and icons cache-first. */
const VERSION = 'xt50-v3';
const SHELL = ['./', 'index.html', 'style.css?v=3', 'renderer.js?v=3', 'analyzer.js?v=3', 'exif.js?v=3', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'fonts/inter-latin-400-normal.woff2', 'fonts/inter-latin-500-normal.woff2', 'fonts/inter-latin-600-normal.woff2',
  'fonts/inter-latin-700-normal.woff2', 'fonts/space-mono-latin-400-normal.woff2', 'fonts/space-mono-latin-700-normal.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const isStatic = /\.(woff2|png)$/.test(req.url);
  e.respondWith(isStatic
    ? caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; }))
    : fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req).then((hit) => hit || caches.match('./'))));
});
