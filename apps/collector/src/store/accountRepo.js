'use strict';
// Users and login sessions. A session is a rotating refresh token: only its SHA-256 hash is
// stored, and every refresh replaces it (a stolen, already-used token is worthless).
const { randomId, randomToken, sha256 } = require('../util/secrets');

const SESSION_TTL_MS = 30 * 86400000;

class AccountRepo {
  constructor({ db, clock, box }) {
    this.db = db;
    this.clock = clock;
    this.box = box; // SecretBox for third-party tokens
  }

  /** Create or update a user from a GitHub profile. */
  async upsertGithubUser(profile, githubToken) {
    const now = this.clock.now();
    const sealed = githubToken ? this.box.seal(githubToken) : null;
    const existing = await this.db.get('SELECT * FROM users WHERE github_id = ?', [profile.id]);
    if (existing) {
      await this.db.run('UPDATE users SET login = ?, name = ?, avatar_url = ?, github_token = COALESCE(?, github_token), last_login_at = ? WHERE id = ?',
        [profile.login, profile.name || null, profile.avatar_url || null, sealed, now, existing.id]);
      return this.getUser(existing.id);
    }
    // A login can be reused on GitHub after a rename; free it from any stale row first.
    await this.db.run("UPDATE users SET login = login || '~' || id WHERE login = ? AND (github_id IS NULL OR github_id <> ?)", [profile.login, profile.id]);
    const id = randomId('usr');
    await this.db.run('INSERT INTO users (id, github_id, login, name, avatar_url, github_token, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, profile.id, profile.login, profile.name || null, profile.avatar_url || null, sealed, now, now]);
    return this.getUser(id);
  }

  /** Development-only users (DEV_LOGIN): no GitHub account behind them. */
  async upsertDevUser(login) {
    const now = this.clock.now();
    const existing = await this.db.get('SELECT * FROM users WHERE login = ?', [login]);
    if (existing) {
      await this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now, existing.id]);
      return this.getUser(existing.id);
    }
    const id = randomId('usr');
    await this.db.run('INSERT INTO users (id, github_id, login, name, avatar_url, github_token, created_at, last_login_at) VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?)',
      [id, login, login, now, now]);
    return this.getUser(id);
  }

  async getUser(id) {
    const u = await this.db.get('SELECT id, github_id, login, name, avatar_url, created_at, last_login_at FROM users WHERE id = ?', [id]);
    return u || null;
  }

  /** Decrypted GitHub user token, or null. */
  async githubToken(userId) {
    const r = await this.db.get('SELECT github_token FROM users WHERE id = ?', [userId]);
    try { return r?.github_token ? this.box.open(r.github_token) : null; } catch { return null; }
  }

  async createSession(userId, userAgent) {
    const token = randomToken();
    const now = this.clock.now();
    await this.db.run('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
      [sha256(token), userId, now, now + SESSION_TTL_MS, userAgent ? String(userAgent).slice(0, 200) : null]);
    return { token, maxAgeS: SESSION_TTL_MS / 1000 };
  }

  /**
   * Exchange a refresh token for a new one. Resolves { user, token } or null when the token is
   * unknown, expired, or already used.
   */
  async rotateSession(token, userAgent) {
    if (!token) return null;
    const id = sha256(token);
    const row = await this.db.get('SELECT * FROM sessions WHERE id = ?', [id]);
    if (!row) return null;
    await this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
    if (row.expires_at < this.clock.now()) return null;
    const user = await this.getUser(row.user_id);
    if (!user) return null;
    const next = await this.createSession(user.id, userAgent);
    return { user, ...next };
  }

  async deleteSession(token) {
    if (token) await this.db.run('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
  }

  async purgeExpiredSessions() {
    await this.db.run('DELETE FROM sessions WHERE expires_at < ?', [this.clock.now()]);
  }
}

module.exports = { AccountRepo, SESSION_TTL_MS };
