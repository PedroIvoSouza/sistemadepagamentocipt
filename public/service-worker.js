// /public/service-worker.js
const V = 'cipt-app-shell-v1.0.0';
const APP_SHELL = [
  '/', '/css/app-shell.css', '/css/assistant-widget.css',
  '/js/ui-kit.js', '/js/mobile-adapter.js', '/js/assistant-widget.js',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css'
];

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(V).then(c=>c.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate', (e)=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==V).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e)=>{
  const { request } = e;
  if (request.method!=='GET') return; // não intercepta POST/emitir/etc.
  e.respondWith((async ()=>{
    const cache = await caches.open(V);
    const cached = await cache.match(request);
    const net = fetch(request).then(r=>{ cache.put(request, r.clone()); return r; }).catch(()=>null);
    return cached || net || new Response('', {status: 504, statusText:'Offline'});
  })());
});
