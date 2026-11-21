const NAME = 'lilt-shell-v1';
const ROOT = '/lilt/';
const safeAsset = url => url.origin === self.location.origin && (url.pathname.startsWith('/lilt/assets/') || /^\/lilt\/fonts\/[a-z-]+\.ttf$/.test(url.pathname) || ['/lilt/favicon.svg', '/lilt/apple-touch-icon.png', '/lilt/icon-192.png', '/lilt/icon-512.png'].includes(url.pathname));

async function saveShell(response, cache) {
  if (!response.ok || new URL(response.url).pathname !== ROOT) return;
  const html = await response.clone().text();
  if (!html.includes('name="application-name" content="Lilt"')) return;
  await cache.put(ROOT, response.clone());
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => new URL(match[1], self.location.origin)).filter(safeAsset);
  await Promise.all(assets.map(async url => {
    const asset = await fetch(url);
    if (asset.ok && safeAsset(new URL(asset.url))) await cache.put(url, asset);
  }));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(NAME);
    try { await saveShell(await fetch(ROOT, { credentials: 'same-origin', cache: 'no-store' }), cache); } catch { /* The app remains usable without an offline shell. */ }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(ROOT)) return;
  if (url.pathname.startsWith('/lilt/api/')) return;
  if (event.request.mode === 'navigate' && url.pathname === ROOT) {
    event.respondWith((async () => {
      const cache = await caches.open(NAME);
      try {
        const response = await fetch(event.request);
        event.waitUntil(saveShell(response.clone(), cache).catch(() => undefined));
        return response;
      } catch { return await cache.match(ROOT) || Response.error(); }
    })());
  } else if (safeAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(NAME);
      try {
        const response = await fetch(event.request);
        if (response.ok && safeAsset(new URL(response.url))) event.waitUntil(cache.put(event.request, response.clone()));
        return response;
      } catch { return await cache.match(event.request) || Response.error(); }
    })());
  }
});
