// Trace waterfall: spans as bars on a shared time axis, nested by parent. Click a span for
// its attributes and events (recorded exceptions show here).
import { useMemo, useState } from 'react';
import { ms, serviceColour } from '../lib/format.js';

function spanMs(s) {
  if (Number.isInteger(s.duration_us)) return s.duration_us / 1000;
  return s.end_time - s.start_time;
}

/** Depth-first order by parent, visiting each span once (parent cycles cannot loop). */
function ordered(spans) {
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const kids = new Map();
  const roots = [];
  for (const s of spans) {
    if (s.parent_span_id && byId.has(s.parent_span_id)) {
      if (!kids.has(s.parent_span_id)) kids.set(s.parent_span_id, []);
      kids.get(s.parent_span_id).push(s);
    } else roots.push(s);
  }
  const out = [];
  const seen = new Set();
  const walk = (s, depth) => {
    if (seen.has(s.span_id)) return;
    seen.add(s.span_id);
    out.push({ span: s, depth });
    for (const c of (kids.get(s.span_id) || []).sort((a, b) => a.start_time - b.start_time)) walk(c, depth + 1);
  };
  for (const r of roots.sort((a, b) => a.start_time - b.start_time)) walk(r, 0);
  for (const s of spans) walk(s, 0);
  return out;
}

export function Waterfall({ trace }) {
  const [open, setOpen] = useState(null);
  const rows = useMemo(() => ordered(trace.spans || []), [trace]);
  if (!rows.length) return <p className="muted">This trace has no spans.</p>;
  const t0 = Math.min(...trace.spans.map((s) => s.start_time));
  const t1 = Math.max(...trace.spans.map((s) => Math.max(s.end_time, s.start_time + spanMs(s))));
  const total = Math.max(1, t1 - t0);

  return (
    <div className="wf" role="tree" aria-label="Spans in this trace">
      {rows.map(({ span: s, depth }) => {
        const d = spanMs(s);
        const isOpen = open === s.span_id;
        const err = s.status === 'ERROR';
        return (
          <div key={s.span_id} role="treeitem" aria-level={depth + 1} aria-expanded={isOpen}>
            <button type="button" className="wf-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.span_id)}>
              <span className="wf-label" style={{ paddingLeft: depth * 14 }} title={`${s.service} · ${s.operation}`}>
                {err ? <span className="dot bad" style={{ marginRight: 6 }} aria-label="error" /> : null}
                {s.operation} <span className="svc">{s.service}</span>
              </span>
              <span className="wf-track" aria-hidden="true">
                <span
                  className={'wf-bar' + (err ? ' err' : '')}
                  style={{ left: `${((s.start_time - t0) / total) * 100}%`, width: `${Math.max(0.4, (d / total) * 100)}%`, '--svc': serviceColour(s.service) }}
                />
              </span>
              <span className="wf-ms">{ms(d)}</span>
            </button>
            {isOpen ? <SpanDetail span={s} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function SpanDetail({ span }) {
  const attrs = Object.entries(span.attributes || {});
  const res = Object.entries(span.resource || {});
  return (
    <div className="wf-detail">
      {span.status === 'ERROR' ? <p style={{ color: 'var(--bad)', fontWeight: 600, marginBottom: 8 }}>Failed{span.status_message ? `: ${span.status_message}` : ''}</p> : null}
      <dl className="kv">
        <dt>Service</dt><dd>{span.service}</dd>
        {span.kind ? <><dt>Kind</dt><dd>{span.kind.toLowerCase()}</dd></> : null}
        <dt>Span id</dt><dd>{span.span_id}</dd>
        {attrs.map(([k, v]) => <FragmentKV key={k} k={k} v={v} />)}
        {res.map(([k, v]) => <FragmentKV key={'r:' + k} k={k} v={v} />)}
      </dl>
      {span.attributes_truncated ? <p className="muted small" style={{ marginTop: 6 }}>Some attributes were too large to keep.</p> : null}
      {(span.events || []).map((e, i) => (
        <div className="event" key={i}>
          <b>{e.name === 'exception' ? 'Exception' : e.name}</b>
          {e.attributes?.['exception.message'] ? <span>: {e.attributes['exception.message']}</span> : null}
          {e.attributes?.['exception.stacktrace'] ? <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{String(e.attributes['exception.stacktrace']).slice(0, 2000)}</pre> : null}
        </div>
      ))}
    </div>
  );
}

const FragmentKV = ({ k, v }) => (<><dt>{k}</dt><dd>{String(v)}</dd></>);
