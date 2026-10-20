const C='study-planner-v42-adventure';
const A=['./','index.html','manifest.json','icon-192.png','icon-512.png','icon-maskable-512.png','icon.svg','ridgeline-ui.css','favicon.svg','favicon-32.png','rl-mark-denali-white.png','rl-mark-denali-navy.png',
  'vendor/round-ui/sp-round.woff2','vendor/fluent-3d/ninja.png','vendor/fluent-3d/fire.png','vendor/fluent-3d/star.png','vendor/fluent-3d/check.png','vendor/fluent-3d/calendar.png','vendor/fluent-3d/tearoff.png','vendor/fluent-3d/scroll.png','vendor/fluent-3d/swords.png','vendor/fluent-3d/gear.png','vendor/fluent-3d/locked.png','vendor/fluent-3d/timer.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A).catch(()=>{})))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))))});
// 2026-10-13：首訪後立刻離線會打不開——網址是「/」，但快取裡只有 index.html。導覽請求改網路優先、離線退回快取的 index.html
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;
  if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('index.html'))));return;}
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)))});
self.addEventListener('message',e=>{if(e.data==='SKIP_WAITING'||e.data==='skipWaiting'||(e.data&&e.data.type==='SKIP_WAITING'))self.skipWaiting()});
