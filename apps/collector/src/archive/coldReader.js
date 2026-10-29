'use strict';
// Reads a trace from a .json.gz cold file; keeps the last 5 decompressed files in an LRU cache.
const fs = require('node:fs');
const zlib = require('node:zlib');

class ColdReader {
  constructor({ repo, metrics, cacheSize = 5 }) {
    this.repo = repo;
    this.metrics = metrics;
    this.cacheSize = cacheSize;
    this.cache = new Map(); // file -> Map(trace_id -> trace)
  }

  _load(file) {
    if (this.cache.has(file)) {
      const v = this.cache.get(file);
      this.cache.delete(file);
      this.cache.set(file, v);
      return v;
    }
    const traces = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    const map = new Map(traces.map((t) => [t.trace_id, t]));
    this.cache.set(file, map);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return map;
  }

  /** @returns {{trace}|{error}|null} null when the id is not in archive_index. */
  read(traceId) {
    const entry = this.repo.getArchiveEntry(traceId);
    if (!entry) return null;
    try {
      const trace = this._load(entry.file_path).get(traceId);
      if (!trace) throw new Error('trace not present in cold file');
      return { trace };
    } catch (err) {
      this.metrics.c.cold_read_errors++;
      return { error: `archive_error: ${err.message}` };
    }
  }
}

module.exports = { ColdReader };
