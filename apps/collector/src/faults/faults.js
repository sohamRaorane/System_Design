'use strict';
// Failure-injection switches. They exist only to demonstrate the eight failure scenarios.

const FAULT_KEYS = {
  storage_down: 'bool',
  archive_down: 'bool',
  slow_drain: 'bool',
  ingest_delay_ms: 'int',
};

function createFaults() {
  const state = { storage_down: false, archive_down: false, slow_drain: false, ingest_delay_ms: 0 };
  return {
    state,
    get(key) {
      return state[key];
    },
    /** @returns {{ok:true, faults}|{ok:false, errors}} */
    update(patch) {
      const errors = [];
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, errors: [{ field: '(body)', reason: 'must be a JSON object' }] };
      }
      for (const [k, v] of Object.entries(patch)) {
        const type = FAULT_KEYS[k];
        if (!type) errors.push({ field: k, reason: 'unknown fault' });
        else if (type === 'bool' && typeof v !== 'boolean') errors.push({ field: k, reason: 'must be a boolean' });
        else if (type === 'int' && (!Number.isInteger(v) || v < 0 || v > 10000)) {
          errors.push({ field: k, reason: 'must be an integer 0..10000' });
        }
      }
      if (errors.length) return { ok: false, errors };
      Object.assign(state, patch);
      return { ok: true, faults: { ...state } };
    },
  };
}

module.exports = { createFaults };
