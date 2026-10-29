'use strict';
// Archive worker (section 5.8): gzip aged traces into the blob store under <day>/,
// then (and only then) index them and delete the hot rows in one transaction.
// A crash between the upload and the index commit leaves a harmless orphan object;
// the next run uploads a fresh copy and the index points at it (E47).
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { backoffDelay, unref } = require('../util/common');

const gzip = promisify(zlib.gzip);
const DAY_MS = 86400000;

class ArchiveWorker {
  constructor({ config, clock, metrics, repo, faults, blob, logger, retentionOverrides }) {
    this.config = config;
    this.clock = clock;
    this.metrics = metrics;
    this.repo = repo;
    this.faults = faults;
    this.blob = blob;
    this.logger = logger;
    // () => [{ projectId, days }]: per-project hot retention shorter than the global one.
    this.retentionOverrides = retentionOverrides || null;
    this.running = false;
    this.timer = null;
    this.stopped = true;
    this.failStreak = 0;
    this.seq = 0;
    this.hooks = {}; // test seam: { beforeDelete(row) }
    config.on('config:changed', (e) => {
      if (!this.stopped && e.changed.includes('archive_interval_ms')) this._arm();
    });
  }

  start() {
    this.stopped = false;
    this.cleanTmp();
    this._arm();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  _arm(delay = this.config.get().archive_interval_ms) {
    clearTimeout(this.timer);
    this.timer = unref(setTimeout(() => this.runOnce().catch(() => {}), delay));
  }

  cleanTmp() {
    try { this.blob.cleanup?.(); } catch (err) { this.logger?.warn?.('archive tmp cleanup failed:', err.message); }
  }

  /** Rows due for archiving: global retention, plus projects with a shorter override. */
  async _due(cfg) {
    const now = this.clock.now();
    const rows = await this.repo.selectAged(now - cfg.hot_retention_days * DAY_MS, cfg.archive_batch_size);
    const overrides = this.retentionOverrides ? this.retentionOverrides() : [];
    for (const { projectId, days } of overrides) {
      if (rows.length >= cfg.archive_batch_size) break;
      if (!(days < cfg.hot_retention_days)) continue;
      const extra = await this.repo.selectAged(now - days * DAY_MS, cfg.archive_batch_size - rows.length, projectId);
      const seen = new Set(rows.map((r) => r.project_id + '\0' + r.trace_id));
      for (const r of extra) if (!seen.has(r.project_id + '\0' + r.trace_id)) rows.push(r);
    }
    return rows;
  }

  /** @returns {{ok:boolean, archived:number, skipped?:boolean, error?:string}} */
  async runOnce() {
    if (this.running) return { ok: true, archived: 0, skipped: true };
    this.running = true;
    const c = this.metrics.c;
    let delay;
    try {
      const cfg = this.config.get();
      const rows = await this._due(cfg);
      c.archive_runs++;
      const groups = new Map();
      for (const r of rows) {
        const day = new Date(r.finalized_at).toISOString().slice(0, 10);
        if (!groups.has(day)) groups.set(day, []);
        groups.get(day).push(r);
      }
      let archived = 0;
      for (const [day, group] of groups) {
        if (this.faults.get('archive_down')) throw new Error('cold storage unavailable (injected fault)');
        const traces = group.map((r) => {
          const { spans_json, ...rest } = r;
          return { ...rest, is_complete: Boolean(r.is_complete), spans: JSON.parse(spans_json) };
        });
        const key = `${day}/batch-${this.clock.now()}-${String(this.seq++).padStart(6, '0')}.json.gz`;
        await this.blob.put(key, await gzip(Buffer.from(JSON.stringify(traces))));
        await this.repo.markArchived(group, key, this.clock.now(), this.hooks);
        archived += group.length;
        c.archived_traces += group.length;
      }
      if (archived) await this.repo.db.checkpoint?.();
      c.last_archive_at = this.clock.now();
      this.failStreak = 0;
      await this._purgeCold(cfg);
      // E50: a full batch means there may be more backlog; continue soon.
      delay = rows.length >= cfg.archive_batch_size ? 100 : undefined;
      return { ok: true, archived };
    } catch (err) {
      c.archive_failures++;
      c.archive_retries++;
      this.failStreak++;
      const cfg = this.config.get();
      delay = backoffDelay(this.failStreak, cfg.retry_base_ms, cfg.retry_max_ms);
      this.logger?.warn?.('archive run failed:', err.message);
      return { ok: false, archived: 0, error: err.message };
    } finally {
      this.running = false;
      if (!this.stopped) this._arm(delay);
    }
  }

  /** Delete day folders older than cold_retention_days, index rows first. */
  async _purgeCold(cfg) {
    try {
      const limit = this.clock.now() - cfg.cold_retention_days * DAY_MS;
      for (const prefix of await this.blob.listPrefixes()) {
        const day = prefix.replace(/\/$/, '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        if (Date.parse(day + 'T23:59:59Z') < limit) {
          await this.repo.purgeArchivePrefix(prefix);
          await this.blob.removePrefix(prefix);
        }
      }
    } catch (err) {
      this.logger?.warn?.('cold purge failed:', err.message);
    }
  }
}

module.exports = { ArchiveWorker };
