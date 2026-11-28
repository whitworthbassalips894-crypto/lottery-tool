'use strict';
const CACHE_NAME='three-in-three-v17'; // 与 app.js 的 APP_BUILD 一起提升
const assets=['./','./index.html','./src/engine.js','./src/data.js','./src/app.js','./data/draws.json','./manifest.json','./icon-192.png','./icon-512.png','./icon-180.png','./favicon-32.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(assets)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('kl8-tool-cache-')||k.startsWith('three-in-three-')&&k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin) return; // 跨域请求始终直连
  // 上游开奖数据与本工具同域（…github.io/Number-selection-tool/…），也必须直连，
  // 否则「检查更新／一键同步」可能读到旧缓存，出现上游已更新却提示没有新增期次。
  if(url.pathname.indexOf('/Number-selection-tool/')===0) return;
  // 页面导航（HTML）走网络优先：有网就拿最新版代码，断网才回退缓存。
  // 旧实现是纯缓存优先：手机装成 PWA 后会永远停在第一次打开的旧版本，
  // 电脑新开标签页却是新版——两边页面不一样，且旧的那边怎么刷新都不会变。
  if(req.mode==='navigate'){
    event.respondWith(
      fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(CACHE_NAME).then(cache=>cache.put(req,copy));
        return res;
      }).catch(()=>caches.match(req).then(hit=>hit||caches.match('./index.html')))
    );
    return;
  }
  // 其余同域资源（JS／内置数据／图标）走「先给缓存、后台更新」：打开快，且下次打开就是新版。
  event.respondWith(
    caches.match(req).then(hit=>{
      const refresh=fetch(req).then(res=>{
        if(res&&res.ok){const copy=res.clone();caches.open(CACHE_NAME).then(cache=>cache.put(req,copy));}
        return res;
      }).catch(()=>hit);
      return hit||refresh;
    })
  );
});
