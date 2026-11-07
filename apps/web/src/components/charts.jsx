// Dependency-free SVG visualisations used across the observability dashboard.
// Every chart is fed by real API data; none of them generate synthetic points.
import { useMemo, useState } from 'react';
import { clockTime, num } from '../lib/format.js';

const W = 760;
const PAD = { l: 46, r: 14, t: 14, b: 26 };

function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((m) => m >= value) || value;
}

function clean(points = []) {
  return points.filter((p) => p && Number.isFinite(p.t) && p.v !== null && p.v !== undefined && Number.isFinite(Number(p.v)));
}

function pathFor(points, xOf, yOf) {
  if (!points.length) return '';
  return points.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ');
}

function AreaFor(points, xOf, yOf, baseY) {
  if (!points.length) return '';
  const line = pathFor(points, xOf, yOf);
  return `${line} L${xOf(points[points.length - 1].t).toFixed(1)},${baseY} L${xOf(points[0].t).toFixed(1)},${baseY} Z`;
}

function Legend({ series }) {
  if (series.length < 1) return null;
  return (
    <div className="viz-legend" aria-hidden="true">
      {series.map((s) => (
        <span key={s.key} className="viz-legend-item">
          <span className="viz-swatch" style={{ background: s.color || 'var(--accent)' }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function LineChart({
  series = [],
  height = 220,
  formatValue = num,
  formatTime = clockTime,
  area = false,
  ariaLabel = 'Time series chart',
  emptyText = 'No samples in this range yet.',
}) {
  const [hover, setHover] = useState(null);
  const H = height;
  const prepared = series.map((s) => ({ ...s, points: clean(s.points) }));
  const all = prepared.flatMap((s) => s.points);

  const range = useMemo(() => {
    if (!all.length) return null;
    const times = all.map((p) => p.t);
    let tMin = Math.min(...times);
    let tMax = Math.max(...times);
    if (tMax - tMin < 1000) { tMin -= 500; tMax += 500; }
    const maxV = Math.max(...all.map((p) => Number(p.v)), 0);
    return { tMin, tMax, maxV: niceMax(maxV) };
  }, [all]);

  if (!range) return <div className="viz-empty">{emptyText}</div>;

  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const baseY = PAD.t + plotH;
  const xOf = (t) => PAD.l + ((t - range.tMin) / (range.tMax - range.tMin)) * plotW;
  const yOf = (v) => PAD.t + plotH * (1 - Number(v) / range.maxV);
  const ticks = [0, 0.5, 1];
  const active = hover === null ? null : range.tMin + ((hover - PAD.l) / plotW) * (range.tMax - range.tMin);

  const nearestFor = (points) => {
    if (!points.length || active === null) return null;
    return points.reduce((best, p) => (Math.abs(p.t - active) < Math.abs(best.t - active) ? p : best), points[0]);
  };

  const tipLeft = hover === null ? 0 : Math.min(92, Math.max(8, (hover / W) * 100));
  const snapTime = active === null ? null : Math.min(range.tMax, Math.max(range.tMin, active));

  return (
    <figure className="viz">
      <Legend series={prepared} />
      <div className="viz-box">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={ariaLabel}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * W;
            setHover(Math.min(W - PAD.r, Math.max(PAD.l, x)));
          }}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((f) => {
            const v = range.maxV * f;
            const y = yOf(v);
            return (
              <g key={f}>
                <line className="viz-grid" x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} />
                <text className="viz-axis" x={PAD.l - 8} y={y + 4} textAnchor="end">{formatValue(v)}</text>
              </g>
            );
          })}
          <text className="viz-axis" x={PAD.l} y={H - 6}>{formatTime(range.tMin)}</text>
          <text className="viz-axis" x={W - PAD.r} y={H - 6} textAnchor="end">{formatTime(range.tMax)}</text>

          {prepared.map((s) => (
            <g key={s.key}>
              {area ? <path className="viz-area" d={AreaFor(s.points, xOf, yOf, baseY)} style={{ fill: s.color || 'var(--accent)', opacity: s.areaOpacity ?? 0.12 }} /> : null}
              <path className="viz-line" d={pathFor(s.points, xOf, yOf)} style={{ stroke: s.color || 'var(--accent)' }} />
            </g>
          ))}

          {hover !== null ? (
            <>
              <line className="viz-cross" x1={hover} x2={hover} y1={PAD.t} y2={baseY} />
              {prepared.map((s) => {
                const p = nearestFor(s.points);
                return p ? <circle key={s.key} className="viz-dot" cx={xOf(p.t)} cy={yOf(p.v)} r="4" style={{ fill: s.color || 'var(--accent)' }} /> : null;
              })}
            </>
          ) : null}
        </svg>
        {hover !== null && snapTime !== null ? (
          <div className="viz-tip" style={{ left: `${tipLeft}%` }} role="status">
            <div className="viz-tip-time">{formatTime(snapTime)}</div>
            {prepared.map((s) => {
              const p = nearestFor(s.points);
              return (
                <div key={s.key} className="viz-tip-row">
                  <span className="viz-swatch" style={{ background: s.color || 'var(--accent)' }} />
                  <span>{s.label}</span>
                  <b>{p ? formatValue(p.v) : '–'}</b>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </figure>
  );
}

export function Sparkline({ points = [], color = 'var(--accent)', height = 34, ariaHidden = true }) {
  const values = clean(points);
  if (values.length < 2) return <div className="spark spark-empty" style={{ height }} aria-hidden="true" />;
  const width = 140;
  const min = Math.min(...values.map((p) => Number(p.v)));
  const max = Math.max(...values.map((p) => Number(p.v)));
  const span = max - min || 1;
  const xOf = (i) => (i / (values.length - 1)) * (width - 2) + 1;
  const yOf = (v) => height - 2 - ((Number(v) - min) / span) * (height - 4);
  const line = values.map((p, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ');
  const areaPath = `${line} L${xOf(values.length - 1).toFixed(1)},${height - 1} L${xOf(0).toFixed(1)},${height - 1} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} aria-hidden={ariaHidden} focusable="false">
      <path d={areaPath} fill={color} opacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function DonutChart({ data = [], centerLabel, centerValue, onSelect, size = 168, thickness = 18 }) {
  const [active, setActive] = useState(null);
  const total = data.reduce((a, d) => a + (d.value || 0), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  if (!total) return <div className="viz-empty">Nothing to show yet.</div>;
  let offset = 0;
  const segments = data.filter((d) => d.value > 0).map((d) => {
    const length = (d.value / total) * circumference;
    const seg = { ...d, length, offset };
    offset += length;
    return seg;
  });
  return (
    <div className={`donut-wrap${onSelect ? ' interactive' : ''}`}>
      <div className="donut" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${centerLabel || 'Distribution'}: ${centerValue ?? num(total)}`}>
          <circle className="donut-track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={thickness} />
          {segments.map((d) => (
            <circle
              key={d.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={d.color}
              strokeWidth={active === d.key ? thickness + 4 : thickness}
              strokeDasharray={`${Math.max(0, d.length - 2)} ${circumference - Math.max(0, d.length - 2)}`}
              strokeDashoffset={-d.offset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              opacity={active && active !== d.key ? 0.45 : 1}
              onMouseEnter={() => setActive(d.key)}
              onMouseLeave={() => setActive(null)}
            >
              <title>{`${d.label}: ${num(d.value)} (${Math.round((d.value / total) * 1000) / 10}%)`}</title>
            </circle>
          ))}
        </svg>
        <div className="donut-center">
          <strong>{centerValue ?? num(total)}</strong>
          <span>{centerLabel}</span>
        </div>
      </div>
      <ul className="donut-legend">
        {data.map((d) => (
          <li key={d.key}>
            {onSelect ? (
              <button type="button" onMouseEnter={() => setActive(d.key)} onMouseLeave={() => setActive(null)} onClick={() => onSelect(d.key)}>
                <span className="viz-swatch" style={{ background: d.color }} />
                <span className="donut-label">{d.label}</span>
                <span className="donut-value">{num(d.value)}</span>
                <span className="donut-pct">{total ? Math.round((d.value / total) * 100) : 0}%</span>
              </button>
            ) : (
              <span className="donut-row">
                <span className="viz-swatch" style={{ background: d.color }} />
                <span className="donut-label">{d.label}</span>
                <span className="donut-value">{num(d.value)}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Histogram({ values = [], bins = 8, formatValue = (v) => `${Math.round(v)} ms`, color = 'var(--accent)', ariaLabel = 'Distribution' }) {
  const cleanValues = values.filter((v) => Number.isFinite(v) && v >= 0);
  const height = 170;
  if (!cleanValues.length) return <div className="viz-empty">No data in this window.</div>;
  const min = Math.min(...cleanValues);
  let max = Math.max(...cleanValues);
  if (max === min) max = min + 1;
  const step = (max - min) / bins;
  const counts = Array.from({ length: bins }, () => 0);
  for (const v of cleanValues) {
    const i = Math.min(bins - 1, Math.floor((v - min) / step));
    counts[i] += 1;
  }
  const peak = Math.max(...counts, 1);
  const barW = (W - PAD.l - PAD.r) / bins;
  const h = (n) => (n / peak) * (height - PAD.t - PAD.b);
  return (
    <figure className="viz">
      <div className="viz-box">
        <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={ariaLabel}>
          <line className="viz-grid" x1={PAD.l} x2={W - PAD.r} y1={height - PAD.b} y2={height - PAD.b} />
          <text className="viz-axis" x={PAD.l - 8} y={PAD.t + 6} textAnchor="end">{peak}</text>
          <text className="viz-axis" x={PAD.l - 8} y={height - PAD.b} textAnchor="end">0</text>
          {counts.map((n, i) => {
            const x = PAD.l + i * barW + 2;
            const bw = Math.max(1, barW - 4);
            const bh = h(n);
            return (
              <g key={i}>
                <rect className="viz-bar" x={x} y={height - PAD.b - bh} width={bw} height={bh} rx="2" style={{ fill: color }}>
                  <title>{`${formatValue(min + i * step)} – ${formatValue(min + (i + 1) * step)}: ${n} traces`}</title>
                </rect>
              </g>
            );
          })}
          <text className="viz-axis" x={PAD.l} y={height - 6}>{formatValue(min)}</text>
          <text className="viz-axis" x={W - PAD.r} y={height - 6} textAnchor="end">{formatValue(max)}</text>
        </svg>
      </div>
    </figure>
  );
}
