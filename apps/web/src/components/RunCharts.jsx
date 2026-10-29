// Live charts for a load-test run. Two small charts instead of one dual-axis chart:
//   1. requests each second: stacked bars, succeeded + failed (legend + direct labels)
//   2. slowest 5 % (p95) latency each second: a single 2px line
// Both have a hover tooltip; a per-second table is available under them.
import { useState } from 'react';
import { ms, num } from '../lib/format.js';

const W = 560;
const H = 180;
const PAD = { l: 40, r: 10, t: 12, b: 24 };

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function Axis({ max, fmt, n }) {
  const ticks = [0, max / 2, max];
  const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  return (
    <g className="axis" aria-hidden="true">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="grid" />
          <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{fmt(t)}</text>
        </g>
      ))}
      <text x={PAD.l} y={H - 6}>0 s</text>
      <text x={W - PAD.r} y={H - 6} textAnchor="end">{n} s</text>
    </g>
  );
}

function Tip({ x, lines }) {
  if (x === null) return null;
  return (
    <div className="chart-tip" style={{ left: `${(x / W) * 100}%` }} role="status">
      {lines.map((l) => <div key={l}>{l}</div>)}
    </div>
  );
}

export function RequestBars({ points, slots }) {
  const [hover, setHover] = useState(null);
  const n = Math.max(slots, points.length, 1);
  const max = niceMax(Math.max(...points.map((p) => (p.ok || 0) + (p.failed || 0)), 1));
  const plotW = W - PAD.l - PAD.r;
  const bw = plotW / n;
  const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const last = points[points.length - 1];
  return (
    <figure className="chart">
      <figcaption>
        <b>Requests each second</b>
        <span className="legend"><span className="sw ok" /> succeeded <span className="sw bad" /> failed</span>
      </figcaption>
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Requests per second over ${points.length} seconds`} onMouseLeave={() => setHover(null)}>
          <Axis max={max} fmt={(v) => num(v)} n={n} />
          {points.map((p, i) => {
            const x = PAD.l + i * bw + 1;
            const w = Math.max(1, bw - 2); // 2px surface gap between bars
            const okH = y(0) - y(p.ok || 0);
            const badH = y(0) - y(p.failed || 0);
            return (
              <g key={p.t} onMouseEnter={() => setHover(i)}>
                <rect x={PAD.l + i * bw} y={PAD.t} width={bw} height={H - PAD.t - PAD.b} fill="transparent" />
                {p.ok ? <rect className="m-ok" x={x} y={y(p.ok)} width={w} height={okH} rx={Math.min(2, w / 2)} /> : null}
                {p.failed ? <rect className="m-bad" x={x} y={y((p.ok || 0) + p.failed)} width={w} height={Math.max(0, badH - (p.ok ? 2 : 0))} rx={Math.min(2, w / 2)} /> : null}
              </g>
            );
          })}
          {hover !== null ? <line className="cross" x1={PAD.l + (hover + 0.5) * bw} x2={PAD.l + (hover + 0.5) * bw} y1={PAD.t} y2={H - PAD.b} /> : null}
        </svg>
        <Tip x={hover === null ? null : PAD.l + (hover + 0.5) * bw} lines={hover === null ? [] : [`Second ${points[hover].t}`, `${num(points[hover].ok)} succeeded`, `${num(points[hover].failed)} failed`, ...(points[hover].skipped ? [`${points[hover].skipped} not sent (app too slow)`] : [])]} />
      </div>
      {last ? <p className="chart-note">Last second: {num(last.ok)} succeeded, {num(last.failed)} failed{last.skipped ? `, ${last.skipped} not sent because the app was too slow` : ''}.</p> : null}
    </figure>
  );
}

export function LatencyLine({ points, slots }) {
  const [hover, setHover] = useState(null);
  const pts = points.filter((p) => p.p95 !== null && p.p95 !== undefined);
  const n = Math.max(slots, points.length, 1);
  const max = niceMax(Math.max(...pts.map((p) => p.p95), 1));
  const plotW = W - PAD.l - PAD.r;
  const xOf = (t) => PAD.l + ((t - 0.5) / n) * plotW;
  const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${y(p.p95).toFixed(1)}`).join(' ');
  const hp = hover === null ? null : pts.reduce((best, p) => (Math.abs(xOf(p.t) - hover) < Math.abs(xOf(best.t) - hover) ? p : best), pts[0]);
  return (
    <figure className="chart">
      <figcaption><b>Slowest 5% of requests (p95)</b></figcaption>
      <div className="chart-box">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="p95 latency per second"
          onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(((e.clientX - r.left) / r.width) * W); }}
          onMouseLeave={() => setHover(null)}
        >
          <Axis max={max} fmt={(v) => (v === 0 ? '0' : ms(v))} n={n} />
          {d ? <path className="m-line" d={d} /> : null}
          {hp ? (
            <>
              <line className="cross" x1={xOf(hp.t)} x2={xOf(hp.t)} y1={PAD.t} y2={H - PAD.b} />
              <circle className="m-dot" cx={xOf(hp.t)} cy={y(hp.p95)} r="4.5" />
            </>
          ) : null}
        </svg>
        <Tip x={hp ? xOf(hp.t) : null} lines={hp ? [`Second ${hp.t}`, `p95 ${ms(hp.p95)}`, `p50 ${ms(hp.p50)}`, `slowest ${ms(hp.max)}`] : []} />
      </div>
      {pts.length ? <p className="chart-note">Now: p95 {ms(pts[pts.length - 1].p95)}, median {ms(pts[pts.length - 1].p50)}.</p> : null}
    </figure>
  );
}

export function RunTable({ points }) {
  return (
    <details className="small">
      <summary>Show every second as a table</summary>
      <table className="simple" style={{ marginTop: 8 }}>
        <thead><tr><th>Second</th><th>Sent</th><th>Succeeded</th><th>Failed</th><th>p50</th><th>p95</th></tr></thead>
        <tbody>{points.map((p) => <tr key={p.t}><td>{p.t}</td><td>{p.sent}</td><td>{p.ok}</td><td>{p.failed}</td><td>{ms(p.p50)}</td><td>{ms(p.p95)}</td></tr>)}</tbody>
      </table>
    </details>
  );
}
