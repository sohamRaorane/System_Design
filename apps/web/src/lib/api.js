// API client. Every call is same-origin: Vite proxies in development, Vercel rewrites in
// production, so the session cookie is first-party and no CORS is involved.
// The short-lived access token lives only in memory; on a 401 the client refreshes once.
const BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || humanError(status, body));
    this.status = status;
    this.body = body;
  }
}

function humanError(status, body) {
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'Not found.';
  if (status >= 500) return 'The collector had a problem. Try again in a moment.';
  return body?.error ? String(body.error).replace(/_/g, ' ') : `Request failed (${status})`;
}

let accessToken = null;
let refreshing = null;
let onSignedOut = () => {};

export function setAccessToken(t) { accessToken = t; }
export function onSessionEnded(fn) { onSignedOut = fn; }

async function raw(path, { method = 'GET', body, headers = {}, signal, auth = true } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      signal,
      credentials: 'include',
      headers: {
        'x-requested-with': 'tracepipe',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(auth && accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, { error: 'network', message: 'Cannot reach the collector. Free hosting sleeps when idle and takes about a minute to wake: try again shortly.' });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  return { res, data };
}

/** Exchange the session cookie for a fresh access token (deduplicated across callers). */
export function refreshSession() {
  if (!refreshing) {
    refreshing = raw('/api/auth/refresh', { method: 'POST', auth: false })
      .then(({ res, data }) => {
        if (!res.ok) { accessToken = null; return null; }
        accessToken = data.access_token;
        return data;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function request(path, opts = {}) {
  let { res, data } = await raw(path, opts);
  if (res.status === 401 && opts.auth !== false && path !== '/api/auth/refresh') {
    const s = await refreshSession();
    if (s) ({ res, data } = await raw(path, opts));
    else onSignedOut();
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

const P = (pid) => `/api/projects/${encodeURIComponent(pid)}`;

export const api = {
  authConfig: () => request('/api/auth/config', { auth: false }),
  devLogin: (login) => request('/api/auth/dev-login', { method: 'POST', body: { login }, auth: false }),
  logout: () => request('/api/auth/logout', { method: 'POST', auth: false }),
  githubStartUrl: (next) => `${BASE}/api/auth/github/start${qs({ next })}`,

  pipeline: () => request('/api/pipeline'),

  projects: () => request('/api/projects'),
  createProject: (name) => request('/api/projects', { method: 'POST', body: { name } }),
  project: (pid) => request(P(pid)),
  updateProject: (pid, patch) => request(P(pid), { method: 'PATCH', body: patch }),
  deleteProject: (pid) => request(P(pid), { method: 'DELETE' }),
  keys: (pid) => request(`${P(pid)}/keys`),
  createKey: (pid, label) => request(`${P(pid)}/keys`, { method: 'POST', body: { label } }),
  revokeKey: (pid, id) => request(`${P(pid)}/keys/${id}`, { method: 'DELETE' }),
  stats: (pid) => request(`${P(pid)}/stats`),
  services: (pid) => request(`${P(pid)}/services`),
  traces: (pid, filters) => request(`${P(pid)}/traces` + qs(filters)),
  trace: (pid, id) => request(`${P(pid)}/traces/${encodeURIComponent(id)}`),

  installations: (next) => request('/api/github/installations' + qs({ next })),
  installationRepos: (iid) => request(`/api/github/installations/${iid}/repos`),
  linkRepo: (pid, installation_id, full_name) => request(`${P(pid)}/repo`, { method: 'POST', body: { installation_id, full_name } }),
  openPullRequest: (pid, service_name) => request(`${P(pid)}/repo/pull-request`, { method: 'POST', body: { service_name } }),
  unlinkRepo: (pid) => request(`${P(pid)}/repo`, { method: 'DELETE' }),

  adminConfig: () => request('/api/admin/config'),
  updateAdminConfig: (patch) => request('/api/admin/config', { method: 'PUT', body: patch }),
  faults: () => request('/api/admin/faults'),
  setFaults: (patch) => request('/api/admin/faults', { method: 'PUT', body: patch }),
  flush: () => request('/api/admin/flush', { method: 'POST' }),
  runArchive: () => request('/api/admin/archive/run', { method: 'POST' }),
};

export { qs };
