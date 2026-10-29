'use strict';
// GitHub REST client on fetch. Covers:
//   * OAuth web flow (sign-in) using the GitHub App's client id/secret (user-to-server token)
//   * GitHub App authentication (RS256 app JWT -> short-lived installation token)
//   * the handful of REST calls the product needs (user, installations, repos, contents, PRs)
// API/web base URLs are configurable so tests run against a local fake GitHub.
const crypto = require('node:crypto');

class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

class GitHubClient {
  constructor({ apiUrl = 'https://api.github.com', webUrl = 'https://github.com', clientId, clientSecret, appId, appPrivateKey, appSlug, fetchImpl = fetch, clock = { now: () => Date.now() } } = {}) {
    this.apiUrl = apiUrl;
    this.webUrl = webUrl;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.appId = appId;
    this.appKey = appPrivateKey ? crypto.createPrivateKey(appPrivateKey) : null;
    this.appSlug = appSlug;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.installationTokens = new Map(); // installationId -> { token, expiresAt }
  }

  // ---------- OAuth (sign-in) ----------

  authorizeUrl({ redirectUri, state }) {
    const p = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, state, allow_signup: 'true' });
    return `${this.webUrl}/login/oauth/authorize?${p}`;
  }

  async exchangeCode({ code, redirectUri }) {
    const res = await this.fetch(`${this.webUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code, redirect_uri: redirectUri }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new GitHubError(res.status || 400, body.error_description || body.error || 'GitHub sign-in failed', body);
    return body; // { access_token, token_type, scope, refresh_token?, expires_in? }
  }

  // ---------- REST ----------

  async request(path, { token, method = 'GET', body, accept = 'application/vnd.github+json', raw = false } = {}) {
    const res = await this.fetch(path.startsWith('http') ? path : this.apiUrl + path, {
      method,
      headers: {
        accept,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tracepipe-collector',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new GitHubError(res.status, (data && data.message) || `GitHub API ${method} ${path} failed (${res.status})`, data);
    return data;
  }

  getUser(token) {
    return this.request('/user', { token });
  }

  // ---------- GitHub App ----------

  get appConfigured() {
    return Boolean(this.appId && this.appKey);
  }

  installUrl(state) {
    return `${this.webUrl}/apps/${this.appSlug}/installations/new${state ? `?state=${encodeURIComponent(state)}` : ''}`;
  }

  /** RS256 JWT identifying the App itself (valid ≤10 min; iat backdated for clock drift). */
  appJwt() {
    if (!this.appConfigured) throw new GitHubError(500, 'GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)');
    const now = Math.floor(this.clock.now() / 1000);
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: String(this.appId) })}`;
    return `${data}.${crypto.sign('sha256', Buffer.from(data), this.appKey).toString('base64url')}`;
  }

  async installationToken(installationId) {
    const cached = this.installationTokens.get(String(installationId));
    if (cached && cached.expiresAt - 60_000 > this.clock.now()) return cached.token;
    const r = await this.request(`/app/installations/${installationId}/access_tokens`, { method: 'POST', token: this.appJwt(), body: {} });
    this.installationTokens.set(String(installationId), { token: r.token, expiresAt: Date.parse(r.expires_at) || this.clock.now() + 3_000_000 });
    return r.token;
  }

  /** Installations of our App that the signed-in user can access. */
  async userInstallations(userToken) {
    const r = await this.request('/user/installations?per_page=100', { token: userToken });
    return r.installations || [];
  }

  /** Repositories the user can access through one installation. */
  async installationRepos(userToken, installationId) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.request(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`, { token: userToken });
      out.push(...(r.repositories || []));
      if (!r.repositories || r.repositories.length < 100) break;
    }
    return out;
  }
}

module.exports = { GitHubClient, GitHubError };
