'use strict';
// Archive worker (section 5.8): gzip aged traces to cold/<day>/, then (and only then) index + delete hot rows.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { backoffDelay, unref } = require('../util/common');

const gzip = promisify(zlib.gzip);

class ArchiveWorker {
  constructor({ config, clock, metrics, repo, faults, coldDir, logger }) {
    this.config = config;
    this.clock = clock;
    this.metrics = metrics;
    this.repo = repo;
    this.faults = faults;
    this.coldDir = coldDir;
    this.logger = logger;
    this.running = false;
    this.timer = null;
    this.stopped = true;
    this.failStreak = 0;
    this.seq = 0;
    const db = repo.db;
    this.selectAged = db.prepare('SELECT * FROM traces WHERE finalized_at < ? ORDER BY finalized_at ASC LIMIT ?');
    this.upsertIndex = db.prepare(`INSERT OR REPLACE INTO archive_index
      (trace_id, file_path, archived_at, status, duration_ms, root_service, finalized_at)
      VALUES (@trace_id, @file_path, @archived_at, @status, @duration_ms, @root_service, @finalized_at)`);
    this.deleteHot = db.prepare('DELETE FROM traces WHERE trace_id = ?');
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

  /** E48: delete leftover .tmp files. */
  cleanTmp() {
    if (!fs.existsSync(this.coldDir)) return;
    for (const day of fs.readdirSync(this.coldDir)) {
      const dir = path.join(this.coldDir, day);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
    }
  }

  /** @returns {{ok:boolean, archived:number, skipped?:boolean, error?:string}} */
  async runOnce() {
    if (this.running) return { ok: true, archived: 0, skipped: true };
    this.running = true;
    const c = this.metrics.c;
    let delay;
    try {
      const cfg = this.config.get();
      const cutoff = this.clock.now() - cfg.hot_retention_days * 86400000;
      const rows = this.selectAged.all(cutoff, cfg.archive_batch_size);
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
        const dir = path.join(this.coldDir, day);
        await fsp.mkdir(dir, { recursive: true });
        const name = `batch-${this.clock.now()}-${this.seq++}.json.gz`;
        const final = path.join(dir, name);
        const tmp = path.join(dir, '.' + name + '.tmp');
        const data = await gzip(Buffer.from(JSON.stringify(traces)));
        const fh = await fsp.open(tmp, 'w');
        try {
          await fh.writeFile(data);
          await fh.sync();
        } finally {
          await fh.close();
        }
        await fsp.rename(tmp, final); // atomic
        const archivedAt = this.clock.now();
        this.repo.db.transaction(() => {
          for (const r of group) {
            this.upsertIndex.run({
              trace_id: r.trace_id, file_path: final, archived_at: archivedAt, status: r.status,
              duration_ms: r.duration_ms, root_service: r.root_service, finalized_at: r.finalized_at,
            });
            this.deleteHot.run(r.trace_id);
          }
        })();
        archived += group.length;
        c.archived_traces += group.length;
      }
      if (archived) {
        try { this.repo.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      }
      c.last_archive_at = this.clock.now();
      this.failStreak = 0;
      this._purgeCold(cfg);
      // E50: if a full batch was taken there may be more backlog; continue soon.
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

  /** Optional purge of day folders older than cold_retention_days. */
  _purgeCold(cfg) {
    try {
      if (!fs.existsSync(this.coldDir)) return;
      const limit = this.clock.now() - cfg.cold_retention_days * 86400000;
      for (const day of fs.readdirSync(this.coldDir)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        if (Date.parse(day + 'T23:59:59Z') < limit) {
          const dir = path.join(this.coldDir, day);
          this.repo.db.prepare('DELETE FROM archive_index WHERE file_path LIKE ?').run(dir + path.sep + '%');
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    } catch (err) {
      this.logger?.warn?.('cold purge failed:', err.message);
    }
  }
}

module.exports = { ArchiveWorker };
