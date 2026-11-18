// sw.js — SoulNix service worker: makes the app installable (PWA) and
// loads instantly on repeat visits. Strategy:
//   - App shell (HTML/CSS/JS/icons/manifest): cache-first, refreshed in
//     the background on every visit so updates arrive on next launch.
//   - Everything else (Supabase API/storage/websocket): NEVER cached —
//     chat data is live and encrypted per-user; the network handles it.
const CACHE = 'soulnix-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/crypto.js',
  './js/auth.js',
  './js/chat.js',
  './js/status.js',
  './js/features.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase etc: network only

  // Cache-first for the app shell; update the copy in the background.
  event.respondWith(
    caches.match(request, { ignoreSearch: request.mode === 'navigate' }).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
