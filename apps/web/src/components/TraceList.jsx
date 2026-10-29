import { ago, ms } from '../lib/format.js';
import { ReasonBadge } from './Reasons.jsx';

export function TraceList({ items, selected, onSelect }) {
  return (
    <ul className="tlist">
      {items.map((t) => (
        <li key={t.trace_id + (t.tier || '')} aria-current={selected === t.trace_id ? 'true' : undefined}>
          <button type="button" onClick={() => onSelect(t.trace_id)}>
            <span className={'dot' + (t.status === 'ERROR' ? ' bad' : t.sample_reason === 'HIGH_LATENCY' ? ' warn' : '')} aria-label={t.status === 'ERROR' ? 'failed' : 'ok'} />
            <span className="op">{t.root_operation || 'unknown operation'}</span>
            <span className="dur">{ms(t.duration_ms)}</span>
            <span className="meta">
              <span>{t.root_service || 'unknown service'}</span>
              {t.span_count !== undefined ? <span>{t.span_count} spans</span> : null}
              <span>{ago(t.finalized_at)}</span>
              <ReasonBadge reason={t.sample_reason} />
              {t.is_complete === false ? <span>incomplete</span> : null}
              {t.tier === 'cold' ? <span>archived</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
