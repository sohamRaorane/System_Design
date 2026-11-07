// Plain-language formatting helpers.

export function ms(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  if (v < 1) return '<1 ms';
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`;
  return `${(v / 60_000).toFixed(1)} min`;
}

export function num(v) {
  if (v === null || v === undefined) return '–';
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(v) >= 10_000) return (v / 1000).toFixed(1) + 'k';
  return new Intl.NumberFormat().format(Math.round(v * 10) / 10);
}

export function ago(ts, now = Date.now()) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(ts).toLocaleDateString();
}

export const plural = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`;

/** Clock time for dense engineering tables: 14:03:27. */
export function clockTime(ts) {
  if (!ts) return '–';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** Compact "3d 4h" style durations for uptimes. */
export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function pct(part, whole) {
  if (!whole) return '–';
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

/** Percentile of a numeric list, using nearest-rank. */
export function percentile(values, p) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[idx];
}

/** Why the sampler kept a trace, in words a person would use. */
export const REASON_TEXT = {
  ERROR: 'Error',
  HIGH_LATENCY: 'Slow',
  INCOMPLETE: 'Incomplete',
  NORMAL_SAMPLED: 'Sampled normal',
};
export const REASON_HELP = {
  ERROR: 'Something failed in this request. Errors are always kept.',
  HIGH_LATENCY: 'Slower than your latency threshold. Slow requests are always kept.',
  INCOMPLETE: 'Some spans never arrived before the timeout. Kept so gaps are visible.',
  NORMAL_SAMPLED: 'A healthy request kept as a sample of normal traffic.',
};

/** Stable colour per service name for waterfall bars. */
const SERVICE_COLOURS = ['#2DD4BF', '#818CF8', '#C084FC', '#4ADE80', '#FBBF24', '#38BDF8', '#F472B6', '#A3E635'];
export function serviceColour(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SERVICE_COLOURS[h % SERVICE_COLOURS.length];
}
