// Recent kept traces as a compact activity feed. The rows are real stored traces, not events
// invented for the dashboard.
import { clockTime, ms, plural } from '../lib/format.js';

export function ActivityTimeline({ items = [], onSelect }) {
  if (!items.length) return <p className="muted small">No recent activity in this window.</p>;
  return (
    <ol className="timeline">
      {items.map((t) => {
        const bad = t.status === 'ERROR';
        const slow = t.sample_reason === 'HIGH_LATENCY';
        const tone = bad ? 'bad' : slow ? 'warn' : 'ok';
        return (
          <li key={t.trace_id + (t.tier || '')}>
            <span className={`timeline-dot tone-${tone}`} aria-hidden="true" />
            <button type="button" className="timeline-body" onClick={() => onSelect?.(t.trace_id)}>
              <span className="timeline-main">
                <b>{t.root_operation || 'unknown operation'}</b>
                <span className="timeline-service">{t.root_service || 'unknown service'}</span>
              </span>
              <span className="timeline-meta">
                <span>{clockTime(t.finalized_at)}</span>
                <span>{ms(t.duration_ms)}</span>
                <span>{plural(t.span_count ?? 0, 'span')}</span>
                {bad ? <span className="tag tag-bad">error</span> : null}
                {slow ? <span className="tag tag-warn">slow</span> : null}
                {t.tier === 'cold' ? <span className="tag">archived</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
