'use strict';
// Local-disk object store for the cold archive (development). Same interface as the
// S3/R2 store: put / get / remove / listPrefixes / cleanup. Writes are atomic
// (tmp file + fsync + rename), so a crash never leaves a half-written object.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

class LocalBlobStore {
  constructor(root) {
    this.kind = 'local';
    this.root = path.resolve(root);
  }

  _path(key) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('invalid object key');
    return p;
  }

  /** Absolute path of an object (local store only; used by tests and diagnostics). */
  pathOf(key) {
    return this._path(key);
  }

  async put(key, data) {
    const final = this._path(key);
    await fsp.mkdir(path.dirname(final), { recursive: true });
    const tmp = path.join(path.dirname(final), '.' + path.basename(final) + '.tmp');
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, final);
  }

  async get(key) {
    return fsp.readFile(this._path(key));
  }

  /** Delete every object whose key starts with prefix (a "folder" such as "2026-01-01/"). */
  async removePrefix(prefix) {
    await fsp.rm(this._path(prefix.replace(/\/$/, '')), { recursive: true, force: true });
  }

  /** Top-level prefixes (day folders). */
  async listPrefixes() {
    if (!fs.existsSync(this.root)) return [];
    return (await fsp.readdir(this.root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name + '/');
  }

  /** E48: delete leftover .tmp files from interrupted writes. */
  cleanup() {
    if (!fs.existsSync(this.root)) return;
    for (const day of fs.readdirSync(this.root)) {
      const dir = path.join(this.root, day);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
    }
  }
}

module.exports = { LocalBlobStore };
