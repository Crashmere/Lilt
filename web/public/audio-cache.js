const AUDIO_CACHE = 'lilt-audio-v1';
const AUDIO_FILE_LIMIT = 128 * 1024 * 1024;
const AUDIO_CACHE_LIMIT = 256 * 1024 * 1024;
const AUDIO_CACHE_COUNT = 8;
const audioEntries = new Map();
const audioClients = new Map();
let audioStorage = Promise.resolve();
const audioRetainedSize = () => [...audioEntries.values()].reduce((total, entry) => total + (entry.size || 0), 0);

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

function audioWait(entry) {
  return new Promise(resolve => entry.waiters.add(resolve));
}

function audioAllowed(entry) {
  const states = [...audioClients.values()].filter(state => Date.now() - state.at <= 15000);
  const playing = states.some(state => state.playing);
  for (const state of states) {
    if (state.current === entry.url && (state.playing || !playing) || state.next === entry.url && state.prefetch && state.playing) return true;
  }
  return false;
}

function audioWanted(entry) {
  return [...audioClients.values()].some(state => Date.now() - state.at <= 15000 && (state.current === entry.url || state.next === entry.url));
}

function audioState(event) {
  const data = event.data;
  if (data?.type === 'lilt-audio-ping') { event.source?.postMessage({ type: 'lilt-audio-ready' }); return; }
  if (data?.type === 'lilt-audio-reset') {
    const url = audioURL(data.url);
    const entry = audioEntries.get(url);
    if (entry && !entry.complete) {
      entry.discarded = true; entry.abort?.abort();
      if (entry.waiters) audioWake(entry);
      audioEntries.delete(url);
    }
    return;
  }
  if (data?.type !== 'lilt-audio-state' || !event.source?.id) return;
  audioClients.set(event.source.id, { current: audioURL(data.current), next: audioURL(data.next), prefetch: !!data.prefetch, playing: !!data.playing, at: Date.now() });
  for (const [id, state] of audioClients) if (Date.now() - state.at > 15000) audioClients.delete(id);
  for (const [url, entry] of audioEntries) {
    if (entry.loading) { if (!audioWanted(entry)) entry.abort.abort(); continue; }
    if (!audioWanted(entry)) {
      if (entry.publishing) continue;
      entry.discarded = !entry.complete;
      entry.abort?.abort();
      audioWake(entry);
      audioEntries.delete(url);
    } else {
      if (!audioAllowed(entry)) entry.abort?.abort();
      audioWake(entry);
    }
  }
}

function audioRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) return;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size ? { start, end, partial: true } : undefined;
}

function audioBody(entry, start, end) {
  let offset = start;
  let index = 0;
  let canceled = false;
  return new ReadableStream({
    async pull(controller) {
      while (!canceled) {
        if (offset > end) { controller.close(); return; }
        if (entry.discarded || entry.error) { controller.error(entry.error || new Error('Audio request superseded')); return; }
        if (offset < entry.received) {
          while (entry.parts[index] && entry.parts[index].start + entry.parts[index].bytes.length <= offset) index++;
          const part = entry.parts[index];
          const length = Math.min(part.bytes.length - (offset - part.start), end - offset + 1);
          // Response consumers may transfer chunks; keep the shared fill reusable.
          controller.enqueue(part.bytes.slice(offset - part.start, offset - part.start + length));
          offset += length;
          return;
        }
        if (entry.complete) { controller.error(new Error('Incomplete audio cache')); return; }
        await audioWait(entry);
      }
    },
    cancel() { canceled = true; audioWake(entry); },
  });
}

function audioResponse(entry, range) {
  const headers = new Headers(entry.headers);
  headers.delete('Content-Encoding');
  headers.delete('Content-Range');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(range.end - range.start + 1));
  if (range.partial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${entry.size}`);
  headers.set('X-Lilt-Buffer', entry.complete ? 'complete' : 'stream');
  const body = entry.blob ? entry.blob.slice(range.start, range.end + 1).stream() : audioBody(entry, range.start, range.end);
  return new Response(body, { status: range.partial ? 206 : 200, headers });
}

function audioPersist(entry) {
  audioStorage = audioStorage.catch(() => undefined).then(async () => {
    const cache = await caches.open(AUDIO_CACHE);
    const records = [];
    for (const key of await cache.keys()) {
      const response = await cache.match(key);
      if (response) records.push({ key, size: Number(response.headers.get('Content-Length')) || 0, at: Number(response.headers.get('X-Lilt-Cached-At')) || 0 });
    }
    const trackPath = new URL(entry.url).pathname;
    let total = entry.size;
    const kept = [];
    for (const record of records.sort((a, b) => b.at - a.at)) {
      if (record.key.url === entry.url || new URL(record.key.url).pathname === trackPath || total + record.size > AUDIO_CACHE_LIMIT || kept.length >= AUDIO_CACHE_COUNT - 1) {
        await cache.delete(record.key);
      } else { kept.push(record); total += record.size; }
    }
    const response = audioResponse(entry, { start: 0, end: entry.size - 1, partial: false });
    response.headers.set('X-Lilt-Cached-At', String(Date.now()));
    await cache.put(entry.url, response);
  });
  return audioStorage.catch(() => undefined);
}

async function audioDownload(entry, first) {
  let response = first;
  try {
    while (entry.received < entry.size && !entry.discarded) {
      while (!audioAllowed(entry) && !entry.discarded) await audioWait(entry);
      if (entry.discarded) break;
      entry.abort = new AbortController();
      try {
        if (!response) {
          response = await fetch(entry.url, {
            credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: entry.abort.signal,
            headers: { Range: `bytes=${entry.received}-`, 'If-Range': entry.etag },
          });
          const expected = `bytes ${entry.received}-`;
          if (response.status !== 206 || !response.headers.get('Content-Range')?.startsWith(expected) || response.headers.get('ETag') !== entry.etag) throw new Error('Audio changed during buffering');
        }
        const reader = response.body.getReader();
        const abort = () => { void reader.cancel().catch(() => undefined); };
        entry.abort.signal.addEventListener('abort', abort, { once: true });
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              if (entry.abort.signal.aborted) break;
              if (entry.received !== entry.size) throw new Error('Incomplete audio response');
              entry.complete = true;
              audioWake(entry);
              entry.publishing = true;
              await audioPersist(entry);
              entry.publishing = false;
              return;
            }
            if (entry.received + value.length > entry.size) throw new Error('Invalid audio response length');
            entry.parts.push({ start: entry.received, bytes: value });
            entry.received += value.length;
            audioWake(entry);
          }
        } finally { entry.abort.signal.removeEventListener('abort', abort); reader.releaseLock(); }
      } catch (error) {
        if (!entry.abort.signal.aborted) throw error;
      }
      response = undefined;
    }
  } catch (error) { entry.error = error; audioWake(entry); }
}

async function audioLoad(request, url, abort) {
  const saved = await caches.open(AUDIO_CACHE).then(cache => cache.match(url)).catch(() => undefined);
  if (saved && Number(saved.headers.get('Content-Length')) + audioRetainedSize() <= AUDIO_CACHE_LIMIT) {
    const check = await fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(15000)]) });
    if (!check.ok) return { response: check };
    if (check.headers.get('ETag') === saved.headers.get('ETag') && check.headers.get('Content-Length') === saved.headers.get('Content-Length')) {
      const blob = await saved.blob();
      return { entry: { url, size: blob.size, received: blob.size, complete: true, headers: check.headers, blob, waiters: new Set() } };
    }
    await caches.open(AUDIO_CACHE).then(cache => cache.delete(url)).catch(() => undefined);
  }
  const timer = setTimeout(() => abort.abort(new Error('Audio headers timed out')), 45000);
  let response;
  try { response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal }); }
  finally { clearTimeout(timer); }
  const size = Number(response.headers.get('Content-Length'));
  const etag = response.headers.get('ETag');
  if (!response.ok || response.status !== 200 || !response.body || !Number.isSafeInteger(size) || size <= 0 || size > AUDIO_FILE_LIMIT || audioRetainedSize() + size > AUDIO_CACHE_LIMIT || etag !== `"${new URL(url).searchParams.get('v')}-original"`) return { response };
  const entry = { url, size, etag, received: 0, complete: false, headers: response.headers, parts: [], waiters: new Set(), discarded: false };
  return { entry, response };
}

async function audioFetch(event, url) {
  const request = event.request;
  let entry = audioEntries.get(url);
  if (entry?.loading) {
    const loaded = await entry.loading;
    if (!loaded.entry) return fetch(request);
    entry = loaded.entry;
  } else if (entry && !entry.error && !entry.discarded) {
    // A new media request must still pass the gateway's device authorization.
    const check = await fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
    if (!check.ok) return check;
    if (check.headers.get('ETag') !== entry.headers.get('ETag')) {
      audioEntries.delete(url);
      return fetch(request);
    }
  } else {
    const abort = new AbortController();
    const loading = audioLoad(request, url, abort);
    const pending = { url, loading, abort };
    audioEntries.set(url, pending);
    let loaded;
    try { loaded = await loading; }
    catch (error) { if (audioEntries.get(url) === pending) audioEntries.delete(url); throw error; }
    if (!loaded.entry) { audioEntries.delete(url); return loaded.response; }
    entry = loaded.entry;
    audioEntries.set(url, entry);
    if (!entry.complete) event.waitUntil(audioDownload(entry, loaded.response));
  }
  const range = audioRange(request.headers.get('Range'), entry.size);
  if (!range) return fetch(request);
  // Container indexes and uncached distant seeks need their own range rather
  // than waiting for the sequential whole-file fill to reach the requested byte.
  if (!entry.complete && range.start > entry.received + 64 * 1024) return fetch(request);
  return audioResponse(entry, range);
}

self.addEventListener('message', audioState);
self.addEventListener('fetch', event => {
  const url = event.request.method === 'GET' && audioURL(event.request.url);
  if (url) event.respondWith(audioFetch(event, url));
});
