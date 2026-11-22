const AUDIO_CACHE = 'lilt-audio-v1';
const AUDIO_FILE_LIMIT = 128 * 1024 * 1024;
const AUDIO_CACHE_LIMIT = 256 * 1024 * 1024;
const AUDIO_CACHE_COUNT = 8;
const AUDIO_CHUNK = 2 * 1024 * 1024;
const AUDIO_FIRST = 128 * 1024;
const AUDIO_NEXT_RATE = 64 * 1024;
const audioEntries = new Map();
const audioClients = new Map();
const audioEditors = new Map();
let audioStorage = Promise.resolve();
let audioNetwork = Promise.resolve();
let audioPumping;
let audioForeground = 0;
let audioPageUntil = 0;
let audioActive;

function audioURL(value) {
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && /^\/lilt\/api\/tracks\/[^/]+\/stream$/.test(url.pathname)
      && url.searchParams.get('quality') === 'original' && url.searchParams.get('buffer') === '1'
      && /^[a-f0-9]{64}$/.test(url.searchParams.get('v') || '') ? url.href : '';
  } catch { return ''; }
}

function audioWake(entry) {
  for (const wake of entry.waiters) wake();
  entry.waiters.clear();
}

function audioStates() {
  return [...audioClients.values()].filter(state => Date.now() - state.at <= 15000);
}

function audioEditorStates() {
  return [...audioEditors.values()].filter(state => Date.now() - state.at <= 15000);
}

function audioRequested(url) {
  // Editor preloading is explicit demand, independent of audible playback intent.
  return audioEditorStates().some(state => state.url === url)
    || audioStates().some(state => state.playing && (state.current === url || state.next === url && state.prefetch));
}

function audioWanted(entry) {
  return audioEditorStates().some(state => state.url === entry.url) || audioStates().some(state => state.current === entry.url || state.next === entry.url);
}

function audioRetain(size) {
  const total = () => [...audioEntries.values()].reduce((sum, entry) => sum + (entry.size || 0), 0);
  for (const entry of [...audioEntries.values()].sort((a, b) => a.at - b.at)) {
    if (total() + size <= AUDIO_CACHE_LIMIT && audioEntries.size < AUDIO_CACHE_COUNT) break;
    if (entry.loading || entry.publishing || entry.consumers.size || audioWanted(entry)) continue;
    entry.discarded = true; entry.abort?.abort(); audioWake(entry); audioEntries.delete(entry.url);
  }
  return total() + size <= AUDIO_CACHE_LIMIT;
}

function audioRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) return;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size ? { start, end, partial: true } : undefined;
}

// Sorted sparse parts let metadata tail reads and seeks share the same bytes as the fill.
function audioPart(entry, offset) {
  let low = 0, high = entry.parts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (entry.parts[mid].start + entry.parts[mid].bytes.length <= offset) low = mid + 1;
    else high = mid;
  }
  return { index: low, part: entry.parts[low] };
}

function audioMissing(entry, offset) {
  while (offset < entry.size) {
    const { part } = audioPart(entry, offset);
    if (!part || part.start > offset) return offset;
    offset = part.start + part.bytes.length;
  }
  return entry.size;
}

function audioPlan(entry) {
  if (entry.loading || entry.initializing || entry.complete || entry.error || entry.discarded) return;
  const states = audioStates();
  const current = states.filter(state => state.current === entry.url && state.playing);
  const next = states.filter(state => state.next === entry.url && state.prefetch && state.playing);
  const editor = audioEditorStates().some(state => state.url === entry.url);
  if (!current.length && !next.length && !editor) return;
  const urgent = current.some(state => state.seeking || state.ahead < 12);
  if (!urgent && (audioForeground || Date.now() < audioPageUntil)) return;
  let start = audioMissing(entry, 0);
  for (const consumer of [...entry.consumers].reverse()) {
    if (consumer.offset <= consumer.end && audioMissing(entry, consumer.offset) === consumer.offset) {
      start = consumer.offset;
      break;
    }
  }
  if (start >= entry.size) return;
  const rate = Math.max(16 * 1024, ...current.map(state => state.rate || entry.rate));
  const fullNext = next.some(state => state.complete);
  const nextLimit = Math.min(entry.size, Math.max(256 * 1024, entry.rate * 12) + AUDIO_FIRST);
  if (!current.length && !editor && !fullNext && entry.received >= nextLimit) return;
  const due = Math.max(entry.retryAt, urgent || editor ? 0 : entry.paceAt);
  const length = current.length || editor ? AUDIO_CHUNK : Math.min(AUDIO_FIRST, fullNext ? AUDIO_FIRST : nextLimit - entry.received);
  const { part } = audioPart(entry, start);
  return { entry, start, end: Math.min(entry.size - 1, start + length - 1, part ? part.start - 1 : entry.size - 1),
    due, priority: urgent ? 0 : current.length || editor ? 1 : 2, rate: urgent || editor ? 0 : current.length ? rate * 1.25 : AUDIO_NEXT_RATE };
}

function audioWithNetwork(task) {
  const work = audioNetwork.catch(() => undefined).then(task);
  audioNetwork = work.catch(() => undefined);
  return work;
}

async function audioRead(entry, response, start, end) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
  if (response.status !== 206 || !response.body || !match || Number(match[1]) !== start || Number(match[2]) !== end
    || Number(match[3]) !== entry.size || Number(response.headers.get('Content-Length')) !== end - start + 1
    || response.headers.get('ETag') !== entry.etag) {
    await response.body?.cancel();
    const error = new Error('Audio range or version changed');
    error.terminal = response.status === 401 || response.status === 404 || response.status === 200 || response.status === 206;
    throw error;
  }
  const reader = response.body.getReader();
  let offset = start;
  try {
    while (offset <= end) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Incomplete audio response');
      if (offset + value.length > end + 1) throw new Error('Invalid audio response length');
      const { index, part } = audioPart(entry, offset);
      if (part && part.start < offset + value.length) throw new Error('Overlapping audio response');
      entry.parts.splice(index, 0, { start: offset, bytes: value });
      entry.received += value.length;
      offset += value.length;
      audioWake(entry);
    }
    // Completion is determined by validated bytes, not by a later transport EOF.
    if (entry.received === entry.size) {
      entry.complete = true; entry.publishing = true; audioWake(entry);
      await audioPersist(entry);
      entry.publishing = false;
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function audioPumpLoop() {
  while (true) {
    const plans = [...audioEntries.values()].map(audioPlan).filter(Boolean);
    if (!plans.length) return;
    const now = Date.now();
    const ready = plans.filter(plan => plan.due <= now).sort((a, b) => a.priority - b.priority || a.entry.at - b.entry.at);
    if (!ready.length) { await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, Math.min(...plans.map(plan => plan.due)) - now)))); continue; }
    const plan = ready[0];
    const entry = plan.entry;
    await audioWithNetwork(async () => {
      if (!audioPlan(entry)) return;
      const started = Date.now(), before = entry.received;
      entry.abort = new AbortController(); audioActive = entry;
      try {
        const response = await fetch(entry.url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          signal: AbortSignal.any([entry.abort.signal, AbortSignal.timeout(45000)]),
          headers: { Range: `bytes=${plan.start}-${plan.end}`, 'If-Range': entry.etag } });
        await audioRead(entry, response, plan.start, plan.end);
        entry.failures = 0; entry.retryAt = 0;
      } catch (error) {
        if (!entry.abort.signal.aborted) {
          entry.failures++;
          entry.retryAt = Date.now() + 1000 * 2 ** Math.min(3, entry.failures - 1);
          if (error.terminal || entry.failures > 3) { entry.error = error; audioWake(entry); }
        }
      } finally {
        if (plan.rate) entry.paceAt = Math.max(Date.now(), started + (entry.received - before) / plan.rate * 1000);
        audioActive = undefined; entry.abort = undefined;
      }
    });
  }
}

function audioPump() {
  if (!audioPumping) audioPumping = audioPumpLoop().finally(() => { audioPumping = undefined; });
  return audioPumping;
}

function audioBody(entry, start, end) {
  const consumer = { offset: start, end };
  let canceled = false;
  entry.consumers.add(consumer);
  const finish = () => { entry.consumers.delete(consumer); audioWake(entry); };
  return new ReadableStream({
    async pull(controller) {
      while (!canceled) {
        if (consumer.offset > end) { finish(); controller.close(); return; }
        if (entry.discarded) { finish(); controller.error(new Error('Audio request superseded')); return; }
        const { part } = audioPart(entry, consumer.offset);
        if (part && part.start <= consumer.offset) {
          const from = consumer.offset - part.start;
          const length = Math.min(part.bytes.length - from, end - consumer.offset + 1);
          controller.enqueue(part.bytes.slice(from, from + length)); consumer.offset += length; return;
        }
        if (entry.error) { finish(); controller.error(entry.error); return; }
        const waiting = new Promise(resolve => entry.waiters.add(resolve));
        void audioPump();
        await waiting;
      }
    },
    cancel() { canceled = true; finish(); },
  });
}

function audioResponse(entry, range) {
  const headers = new Headers(entry.headers);
  headers.delete('Content-Encoding'); headers.delete('Content-Range');
  headers.set('Accept-Ranges', 'bytes'); headers.set('Content-Length', String(range.end - range.start + 1));
  if (range.partial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${entry.size}`);
  headers.set('X-Lilt-Buffer', entry.complete ? 'complete' : 'stream');
  return new Response(entry.blob ? entry.blob.slice(range.start, range.end + 1).stream() : audioBody(entry, range.start, range.end), { status: range.partial ? 206 : 200, headers });
}

function audioPersist(entry) {
  audioStorage = audioStorage.catch(() => undefined).then(async () => {
    const cache = await caches.open(AUDIO_CACHE);
    const records = [];
    for (const key of await cache.keys()) {
      const response = await cache.match(key);
      if (response) records.push({ key, size: Number(response.headers.get('Content-Length')) || 0, at: Number(response.headers.get('X-Lilt-Cached-At')) || 0 });
    }
    let total = entry.size, count = 1;
    for (const record of records.sort((a, b) => b.at - a.at)) {
      if (new URL(record.key.url).pathname === new URL(entry.url).pathname || total + record.size > AUDIO_CACHE_LIMIT || count >= AUDIO_CACHE_COUNT) await cache.delete(record.key);
      else { total += record.size; count++; }
    }
    const response = audioResponse(entry, { start: 0, end: entry.size - 1, partial: false });
    response.headers.set('X-Lilt-Cached-At', String(Date.now()));
    await cache.put(entry.url, response);
  });
  return audioStorage.catch(() => undefined);
}

async function audioCheck(request, url) {
  return fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
}

async function audioLoad(request, url) {
  const saved = await caches.open(AUDIO_CACHE).then(cache => cache.match(url)).catch(() => undefined);
  if (saved && audioRetain(Number(saved.headers.get('Content-Length')))) {
    const check = await audioCheck(request, url);
    if (!check.ok) return { response: check };
    if (check.headers.get('ETag') === saved.headers.get('ETag') && check.headers.get('Content-Length') === saved.headers.get('Content-Length')) {
      const blob = await saved.blob();
      return { entry: { url, size: blob.size, received: blob.size, complete: true, headers: check.headers, blob, consumers: new Set(), waiters: new Set(), at: Date.now() } };
    }
    await caches.open(AUDIO_CACHE).then(cache => cache.delete(url)).catch(() => undefined);
  }
  if (!audioRequested(url)) return { response: await fetch(request) };
  let resolve, reject;
  const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
  const download = audioWithNetwork(async () => {
    const started = Date.now();
    const abort = new AbortController();
    const start = Number(/^bytes=(\d+)-/.exec(request.headers.get('Range') || '')?.[1] || 0);
    const current = audioEditorStates().some(state => state.url === url) || audioStates().some(state => state.current === url && state.playing);
    const length = current ? AUDIO_CHUNK : AUDIO_FIRST;
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45000)]), headers: { Range: `bytes=${start}-${start + length - 1}` } });
    if (!response.ok) { resolve({ response }); return; }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
    const size = Number(match?.[3]);
    const etag = response.headers.get('ETag');
    if (response.status !== 206 || !match || size <= 0 || size > AUDIO_FILE_LIMIT || !audioRetain(size) || etag !== `"${new URL(url).searchParams.get('v')}-original"`) {
      await response.body?.cancel(); resolve({ response: await fetch(request) }); return;
    }
    const rate = Number(response.headers.get('X-Lilt-Bitrate')) / 8 || 192 * 1024;
    const entry = { url, size, etag, rate, received: 0, complete: false, initializing: true, abort, headers: response.headers, parts: [], consumers: new Set(), waiters: new Set(), at: Date.now(), failures: 0, retryAt: 0, paceAt: current ? 0 : started + length / AUDIO_NEXT_RATE * 1000 };
    audioActive = entry;
    resolve({ entry, download });
    if (!audioRequested(url)) abort.abort();
    try { await audioRead(entry, response, start, Math.min(size - 1, start + length - 1)); }
    catch (error) { if (!abort.signal.aborted) { if (error.terminal) entry.error = error; entry.failures = 1; entry.retryAt = Date.now() + 1000; } }
    finally { entry.initializing = false; entry.abort = undefined; audioActive = undefined; audioWake(entry); }
  }).catch(error => { reject(error); });
  return ready;
}

async function audioFetch(event, url) {
  const request = event.request;
  let entry = audioEntries.get(url);
  if (entry?.loading) {
    const loaded = await entry.loading;
    if (!loaded.entry) return fetch(request);
    entry = loaded.entry;
    const check = await audioCheck(request, url);
    if (!check.ok) return check;
    if (check.headers.get('ETag') !== entry.headers.get('ETag')) return fetch(request);
  } else if (entry && !entry.discarded) {
    const check = await audioCheck(request, url);
    if (!check.ok) return check;
    if (check.headers.get('ETag') !== entry.headers.get('ETag') || Number(check.headers.get('Content-Length')) !== entry.size) {
      entry.discarded = true; entry.abort?.abort(); audioWake(entry); audioEntries.delete(url); return fetch(request);
    }
  } else {
    const loading = audioLoad(request, url);
    const pending = { url, loading, at: Date.now() };
    audioEntries.set(url, pending);
    let loaded;
    try { loaded = await loading; }
    catch (error) { if (audioEntries.get(url) === pending) audioEntries.delete(url); throw error; }
    if (!loaded.entry) { audioEntries.delete(url); return loaded.response; }
    entry = loaded.entry; audioEntries.set(url, entry);
    if (loaded.download) event.waitUntil(loaded.download.then(() => audioPump()));
  }
  entry.at = Date.now();
  const range = audioRange(request.headers.get('Range'), entry.size);
  if (!range) return fetch(request);
  const response = audioResponse(entry, range);
  event.waitUntil(audioPump());
  return response;
}

self.addEventListener('message', event => {
  const data = event.data;
  if (data?.type === 'lilt-audio-ping') { event.source?.postMessage({ type: 'lilt-audio-ready' }); return; }
  if (data?.type === 'lilt-audio-reset') {
    const entry = audioEntries.get(audioURL(data.url));
    if (entry && !entry.loading && !entry.complete) { entry.error = undefined; entry.failures = 0; audioWake(entry); }
  } else if (data?.type === 'lilt-audio-editor' && event.source?.id) {
    const url = audioURL(data.url);
    if (url) audioEditors.set(event.source.id, { url, at: Date.now() });
    else audioEditors.delete(event.source.id);
    for (const [id, state] of audioEditors) if (Date.now() - state.at > 15000) audioEditors.delete(id);
    event.ports[0]?.postMessage({ ready: true });
  } else if (data?.type === 'lilt-audio-state' && event.source?.id) {
    audioClients.set(event.source.id, { current: audioURL(data.current), next: audioURL(data.next), prefetch: !!data.prefetch,
      playing: !!data.playing, ahead: Math.max(0, Number(data.ahead) || 0), rate: Math.max(0, Number(data.rate) || 0), complete: !!data.complete, seeking: !!data.seeking, at: Date.now() });
    for (const [id, state] of audioClients) if (Date.now() - state.at > 15000) audioClients.delete(id);
  } else return;
  if (audioActive) {
    const plan = audioActive.initializing ? audioRequested(audioActive.url) : audioPlan(audioActive);
    const urgentElsewhere = audioStates().some(state => state.playing && state.current && state.current !== audioActive.url && (state.seeking || state.ahead < 12));
    const activeUrgent = audioStates().some(state => state.playing && state.current === audioActive.url && (state.seeking || state.ahead < 12));
    if (!plan || urgentElsewhere && !activeUrgent) audioActive.abort?.abort();
  }
  for (const entry of audioEntries.values()) if (!entry.loading) audioWake(entry);
  event.waitUntil(audioPump());
});

self.addEventListener('fetch', event => {
  const url = event.request.method === 'GET' && audioURL(event.request.url);
  if (url) {
    // Chrome rejects mixing native response URLs with constructed range responses.
    event.respondWith(audioFetch(event, url).then(response => response.url
      ? new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers }) : response));
    return;
  }
  const path = new URL(event.request.url).pathname;
  if (event.request.method !== 'GET' || !/^\/lilt\/api\/(library$|tracks\/[^/]+\/(cover|lyrics)$)/.test(path)) return;
  audioForeground++; audioPageUntil = Date.now() + 1000;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      // Keep speculation suspended until the small foreground response has transferred.
      if (response.body) await response.clone().arrayBuffer();
      return response;
    } finally { audioForeground--; event.waitUntil(audioPump()); }
  })());
});
