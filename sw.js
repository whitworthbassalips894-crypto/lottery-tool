'use strict';
const CACHE_NAME='three-in-three-v1';
const assets=['./','./index.html','./src/engine.js','./src/data.js','./src/app.js','./data/draws.json','./manifest.json','./icon-192.png','./icon-512.png','./icon-180.png','./favicon-32.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(assets)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('kl8-tool-cache-')||k.startsWith('three-in-three-')&&k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin) return; // 远程同步始终直连，不使用离线缓存冒充最新数据
  event.respondWith(caches.match(event.request).then(hit=>hit || fetch(event.request)));
});
