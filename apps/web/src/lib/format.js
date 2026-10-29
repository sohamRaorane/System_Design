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
const SERVICE_COLOURS = ['#0E7470', '#56648F', '#8A5A9E', '#2F7F3B', '#9A6A1F', '#33729E', '#A0476B', '#5F7A2A'];
export function serviceColour(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SERVICE_COLOURS[h % SERVICE_COLOURS.length];
}
