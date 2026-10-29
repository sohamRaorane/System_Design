'use strict';
// Reads a trace from a gzip archive object; keeps the last few decompressed objects in an
// LRU cache. Decompression is async so a cold read never blocks the event loop.
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gunzip = promisify(zlib.gunzip);

class ColdReader {
  constructor({ repo, blob, metrics, cacheSize = 5 }) {
    this.repo = repo;
    this.blob = blob;
    this.metrics = metrics;
    this.cacheSize = cacheSize;
    this.cache = new Map(); // object key -> Map(project\0trace -> trace)
  }

  async _load(key) {
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, v);
      return v;
    }
    const traces = JSON.parse((await gunzip(await this.blob.get(key))).toString('utf8'));
    const map = new Map(traces.map((t) => [(t.project_id || 'default') + '\0' + t.trace_id, t]));
    this.cache.set(key, map);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return map;
  }

  /** @returns {Promise<{trace}|{error}|null>} null when the id is not in archive_index. */
  async read(projectId, traceId) {
    const entry = await this.repo.getArchiveEntry(projectId, traceId);
    if (!entry) return null;
    try {
      const trace = (await this._load(entry.object_key)).get(projectId + '\0' + traceId);
      if (!trace) throw new Error('trace not present in archive object');
      return { trace };
    } catch (err) {
      this.metrics.c.cold_read_errors++;
      return { error: `archive_error: ${err.message}` };
    }
  }
}

module.exports = { ColdReader };
