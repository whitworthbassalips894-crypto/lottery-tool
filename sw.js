const CACHE_NAME = 'kl8-tool-cache-v3';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
  './favicon-32.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.all(urlsToCache.map(url => {
        try { return cache.add(new Request(url, { cache: 'reload' })); } catch (e) { return Promise.resolve(); }
      })).catch(() => {});
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // 数据文件一律 network-first：保证“一键同步”拿到最新 data/kl8-latest.json
  if (url.pathname.includes('/data/')) {
    // 同步必须联网，不能把离线旧缓存当成实时结果。
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) { return response; }
      return fetch(event.request);
    })
  );
});
