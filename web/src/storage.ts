import { request } from './api';
import type { HistoryEntry, Library } from './types';
import { readLocal, writeLocal } from './utils';

const database = new Promise<IDBDatabase>((resolve, reject) => {
  if (!globalThis.indexedDB) { reject(new Error('此浏览器无法保存音乐库信息。')); return; }
  const open = indexedDB.open('lilt-browser', 1);
  open.onupgradeneeded = () => { open.result.createObjectStore('settings'); };
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(new Error('无法打开浏览器存储。'));
});
database.catch(() => undefined);

async function operation<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = action(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(result.result);
    tx.onerror = () => reject(tx.error || new Error('存储失败。'));
    tx.onabort = () => reject(tx.error || new Error('存储空间不足。'));
  });
}
export const saveLibrary = (library: Library) => operation('settings', 'readwrite', store => store.put(library, 'library'));
export const loadLibrary = () => operation<Library | undefined>('settings', 'readonly', store => store.get('library'));
export function recordHistory(entry: Pick<HistoryEntry, 'trackId' | 'sessionId' | 'seconds' | 'completed'>): void {
  const pending = readLocal<Record<string, typeof entry>>('lilt.pending-history', {});
  pending[entry.sessionId] = entry;
  writeLocal('lilt.pending-history', pending);
  void flushHistory();
}
let flushing = false;
export async function flushHistory(): Promise<void> {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const pending = readLocal<Record<string, Pick<HistoryEntry, 'trackId' | 'sessionId' | 'seconds' | 'completed'>>>('lilt.pending-history', {});
    for (const entry of Object.values(pending)) {
      await request('/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
      const latest = readLocal<typeof pending>('lilt.pending-history', {});
      if (latest[entry.sessionId]?.seconds <= entry.seconds) delete latest[entry.sessionId];
      writeLocal('lilt.pending-history', latest);
    }
  } catch { /* Pending listening updates are retried after connectivity returns. */ }
  finally { flushing = false; }
}
