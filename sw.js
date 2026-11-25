'use strict';
const CACHE_NAME='three-in-three-v14'; // 与 app.js 的 APP_BUILD 一起提升
const assets=['./','./index.html','./src/engine.js','./src/data.js','./src/app.js','./data/draws.json','./manifest.json','./icon-192.png','./icon-512.png','./icon-180.png','./favicon-32.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(assets)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('kl8-tool-cache-')||k.startsWith('three-in-three-')&&k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin) return; // 跨域请求始终直连
  // 上游开奖数据与本工具同域（…github.io/Number-selection-tool/…），也必须直连，
  // 否则「检查更新／一键同步」可能读到旧缓存，出现上游已更新却提示没有新增期次。
  if(url.pathname.indexOf('/Number-selection-tool/')===0) return;
  event.respondWith(caches.match(event.request).then(hit=>hit || fetch(event.request)));
});
