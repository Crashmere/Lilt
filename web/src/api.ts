export const BASE = '/lilt/';
export const API = `${BASE}api`;

export class ApiError extends Error {
  constructor(public status: number, public data: Record<string, unknown>, message: string) { super(message); }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { credentials: 'same-origin', ...init });
  const data = await response.json().catch(error => { if (response.ok) throw error; return {}; });
  if (!response.ok) {
    const message = response.status === 401 ? '设备授权已失效，请重新打开服务。' : response.status === 413 ? '文件块超过上传限制。' : data.error || `请求失败（${response.status}）`;
    throw new ApiError(response.status, data, message);
  }
  return data as T;
}

export function isTransient(error: unknown): boolean {
  return error instanceof TypeError || error instanceof SyntaxError
    || error instanceof DOMException && error.name === 'TimeoutError'
    || error instanceof ApiError && [408, 429, 500, 502, 503, 504].includes(error.status);
}

export async function read<T>(path: string, signal: AbortSignal, timeout = 90000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    try { return await request<T>(path, { signal: attemptSignal }); }
    catch (error) {
      const failure = attemptSignal.aborted ? attemptSignal.reason : error;
      if (signal.aborted || !isTransient(failure) || attempt >= 3) throw failure;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000 * 2 ** attempt);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }
}

export function json<T>(path: string, method: string, data?: unknown): Promise<T> {
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
}
export const trackURL = (id: string, suffix: string) => `${API}/tracks/${encodeURIComponent(id)}/${suffix}`;
export const messageOf = (error: unknown) => error instanceof Error ? (error.message === 'Failed to fetch' ? '无法连接，请检查网络后重试。' : error.message) : '操作失败，请重试。';
