import { REASON_HELP, REASON_TEXT, num } from '../lib/format.js';

const ORDER = ['ERROR', 'HIGH_LATENCY', 'INCOMPLETE', 'NORMAL_SAMPLED'];

/** Horizontal bars: how many traces were kept for each reason. */
export function Reasons({ counts, onPick }) {
  const total = ORDER.reduce((a, k) => a + (counts?.[k] || 0), 0);
  if (!total) return <p className="muted small">Nothing kept yet. Kept traces will be grouped here by why they were kept.</p>;
  const max = Math.max(...ORDER.map((k) => counts[k] || 0));
  return (
    <div className="reasons">
      {ORDER.map((k) => (
        <div key={k} className={`reason r-${k}`} title={REASON_HELP[k]}>
          {onPick ? (
            <button type="button" className="reason-link" onClick={() => onPick(k)}>{REASON_TEXT[k]}</button>
          ) : <span>{REASON_TEXT[k]}</span>}
          <div className="track" aria-hidden="true"><div className="fill" style={{ width: `${((counts[k] || 0) / max) * 100}%` }} /></div>
          <span className="count">{num(counts[k] || 0)}</span>
        </div>
      ))}
    </div>
  );
}

export function ReasonBadge({ reason }) {
  if (!reason) return null;
  return <span className={`badge r-${reason}`} title={REASON_HELP[reason]}>{REASON_TEXT[reason] || reason}</span>;
}
