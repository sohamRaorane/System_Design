// API client. Every call is same-origin: Vite proxies in development, Vercel rewrites in
// production, so cookies are first-party and no CORS is involved.
const BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      signal,
      credentials: 'include',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, { error: 'network', message: 'Cannot reach the collector. It may be starting up (free hosting sleeps when idle) — try again in a minute.' });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

export const api = {
  metrics: () => request('/metrics'),
  health: () => request('/health'),
  traces: (project, filters) => request('/v1/traces' + qs({ project, ...filters })),
  trace: (project, id) => request(`/v1/traces/${encodeURIComponent(id)}` + qs({ project })),
};

export { qs };
