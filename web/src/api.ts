export const BASE = '/lilt/';
export const API = `${BASE}api`;

export class ApiError extends Error {
  constructor(public status: number, public data: Record<string, unknown>, message: string) { super(message); }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { credentials: 'same-origin', ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = response.status === 401 ? '设备授权已失效，请重新打开服务。' : response.status === 413 ? '文件块超过上传限制。' : data.error || `请求失败（${response.status}）`;
    throw new ApiError(response.status, data, message);
  }
  return data as T;
}

export function json<T>(path: string, method: string, data?: unknown): Promise<T> {
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
}
export const trackURL = (id: string, suffix: string) => `${API}/tracks/${encodeURIComponent(id)}/${suffix}`;
export const messageOf = (error: unknown) => error instanceof Error ? (error.message === 'Failed to fetch' ? '无法连接，请检查网络后重试。' : error.message) : '操作失败，请重试。';
