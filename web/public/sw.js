importScripts('/lilt/audio-cache.js');

const ROOT = '/lilt/';
const PREFIX = 'lilt-shell-v2-';
const META = 'lilt-shell-meta-v2';
const READY = `${ROOT}__shell-ready__`;
const safeAsset = url => url.origin === self.location.origin && (url.pathname.startsWith('/lilt/assets/') || /^\/lilt\/fonts\/[a-z-]+\.ttf$/.test(url.pathname) || ['/lilt/audio-cache.js', '/lilt/favicon.svg', '/lilt/apple-touch-icon.png', '/lilt/icon-192.png', '/lilt/icon-512.png', '/lilt/manifest.webmanifest'].includes(url.pathname));
let updating;
const sameETag = (actual, expected) => actual?.replace(/^W\//, '') === expected;

async function shellState() {
  const saved = await (await caches.open(META)).match(ROOT);
  return saved ? saved.json() : {};
}

async function publishedCaches() {
  const state = await shellState();
  const names = [...new Set([state.current, state.previous, ...await caches.keys()].filter(name => name && (name.startsWith(PREFIX) || name === 'lilt-shell-v1')))];
  const result = [];
  for (const name of names) {
    const cache = await caches.open(name);
    if (name === 'lilt-shell-v1' || await cache.match(READY)) result.push({ name, cache });
  }
  return result;
}

async function cachedResponse(request, etag) {
  for (const { cache } of await publishedCaches()) {
    const response = await cache.match(request);
    if (response && (!etag || sameETag(response.headers.get('ETag'), etag))) return response;
  }
}

function clientAssets(client) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = result => { clearTimeout(timer); channel.port1.close(); resolve(result); };
    const timer = setTimeout(() => finish(undefined), 1500);
    channel.port1.onmessage = event => finish(Array.isArray(event.data) ? event.data : undefined);
    client.postMessage({ type: 'lilt-shell-assets' }, [channel.port2]);
  });
}

async function pruneShells(state, ownedUpdate = false) {
  const clients = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(client => new URL(client.url).pathname.startsWith(ROOT));
  const required = await Promise.all(clients.map(clientAssets));
  // Old or suspended clients cannot report their build. Keep their shell until
  // a later navigation can establish which cached builds are still in use.
  if (required.some(assets => !assets || !assets.length)) return;
  const published = await publishedCaches();
  const keep = new Set([META, state.current, state.previous]);
  for (const assets of required) {
    let found = false;
    for (const { name, cache } of published) {
      const saved = await cache.match(READY);
      if (!saved) continue;
      const manifest = await saved.json();
      const urls = new Set(manifest.assets.map(asset => new URL(asset.url, self.location.origin).href));
      if (assets.every(url => urls.has(url))) { keep.add(name); found = true; break; }
    }
    if (!found) return;
  }
  const names = await caches.keys();
  const latest = await shellState();
  if ((!ownedUpdate && updating) || latest.current !== state.current || latest.previous !== state.previous) return;
  await Promise.all(names.filter(name => (name.startsWith(PREFIX) || name === 'lilt-shell-v1') && !keep.has(name)).map(name => caches.delete(name)));
}

async function publishShell(rootResponse) {
  const response = await fetch(`${ROOT}shell-manifest.json`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!response.ok) return;
  const manifest = await response.json();
  if (!/^[a-f0-9]{64}$/.test(manifest.version) || !Array.isArray(manifest.assets) || !manifest.assets.some(asset => asset.url === ROOT)
    || !manifest.assets.every(asset => typeof asset.etag === 'string' && (asset.url === ROOT || safeAsset(new URL(asset.url, self.location.origin))))) return;
  const name = PREFIX + manifest.version;
  const previous = await shellState();
  const cache = await caches.open(name);
  const wasReady = !!await cache.match(READY);
  if (previous.current === name && wasReady) { await pruneShells(previous, true); return; }
  let state;
  try {
    const pending = [...manifest.assets];
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length) {
        const asset = pending.shift();
        let result = asset.url === ROOT && sameETag(rootResponse?.headers.get('ETag'), asset.etag) ? rootResponse.clone() : await cachedResponse(asset.url, asset.etag);
        if (!result) result = await fetch(asset.url, { credentials: 'same-origin', redirect: 'error' });
        if (!result.ok || !sameETag(result.headers.get('ETag'), asset.etag) || new URL(result.url).pathname !== asset.url) throw new Error('Incomplete application shell');
        await cache.put(asset.url, result);
      }
    }));
    if (results.some(result => result.status === 'rejected')) throw new Error('Incomplete application shell');
    await cache.put(READY, new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }));
    state = { current: name, previous: previous.current === name ? previous.previous : previous.current };
    await (await caches.open(META)).put(ROOT, new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } }));
  } catch (error) {
    if (!wasReady) await caches.delete(name);
    throw error;
  }
  await pruneShells(state, true).catch(() => undefined);
}

function updateShell(rootResponse) {
  if (!updating) updating = publishShell(rootResponse).finally(() => { updating = undefined; });
  return updating;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try { await updateShell(); } catch { /* Shell caching is a conditional enhancement. */ }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('message', event => {
  if (event.data?.type !== 'lilt-shell-ready') return;
  event.waitUntil((async () => {
    if (updating) await updating.catch(() => undefined);
    await pruneShells(await shellState());
  })().catch(() => undefined));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(ROOT) || url.pathname.startsWith('/lilt/api/')) return;
  if (event.request.mode === 'navigate' && url.pathname === ROOT) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok && new URL(response.url).pathname === ROOT) event.waitUntil(updateShell(response.clone()).catch(() => undefined));
        return response;
      } catch { return await cachedResponse(ROOT).catch(() => undefined) || Response.error(); }
    })());
  } else if (safeAsset(url)) {
    event.respondWith((async () => {
      if (url.pathname.startsWith('/lilt/assets/')) {
        const cached = await cachedResponse(event.request).catch(() => undefined);
        if (cached) return cached;
      }
      try { return await fetch(event.request); }
      catch { return await cachedResponse(event.request).catch(() => undefined) || Response.error(); }
    })());
  }
});
