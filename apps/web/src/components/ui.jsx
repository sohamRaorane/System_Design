// Small presentational building blocks shared by every dashboard page.
export function Panel({ title, subtitle, actions, children, className = '', ...rest }) {
  return (
    <section className={`panel${className ? ' ' + className : ''}`} {...rest}>
      {title || actions ? (
        <div className="panel-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {subtitle ? <p className="panel-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function MetricCard({ label, value, unit, hint, tone = 'neutral', meta, spark, className = '' }) {
  return (
    <article className={`metric-card tone-${tone}${className ? ' ' + className : ''}`}>
      <div className="metric-top">
        <span className="metric-label">{label}</span>
        {meta || null}
      </div>
      <div className="metric-value">
        {value}
        {unit ? <span className="metric-unit">{unit}</span> : null}
      </div>
      {hint ? <p className="metric-hint">{hint}</p> : null}
      {spark ? <div className="metric-spark">{spark}</div> : null}
    </article>
  );
}

const TONE_LABEL = { ok: 'Healthy', warn: 'Warning', bad: 'Critical', info: 'Info', idle: 'Idle', neutral: 'Neutral' };

export function StatusBadge({ tone = 'neutral', children, pulse = false, title }) {
  return (
    <span className={`status-badge tone-${tone}${pulse ? ' pulse-soft' : ''}`} title={title}>
      <span className={`dot${tone === 'ok' ? '' : tone === 'warn' ? ' warn' : tone === 'bad' ? ' bad' : tone === 'idle' ? ' idle' : ' info'}`} aria-hidden="true" />
      {children || TONE_LABEL[tone] || tone}
    </span>
  );
}

export function StateDot({ state = 'ok' }) {
  return <span className={`dot ${state === 'ok' ? '' : state}`} aria-hidden="true" />;
}

export function EmptyState({ title, children, action, compact = false }) {
  return (
    <div className={`empty${compact ? ' compact' : ''}`}>
      {title ? <p className="empty-title">{title}</p> : null}
      {children ? <p className="small muted">{children}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function LoadingSkeleton({ rows = 3, label = 'Loading' }) {
  return (
    <div className="skeleton-stack" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: i === 0 ? 18 : 12, width: i === 0 ? '42%' : `${88 - i * 9}%` }} />
      ))}
    </div>
  );
}

export function ErrorNotice({ error, children }) {
  if (!error) return null;
  return (
    <div className="notice bad" role="alert">
      <strong>{error.message || 'Request failed.'}</strong>
      {children ? <div className="small" style={{ marginTop: 4 }}>{children}</div> : null}
    </div>
  );
}

export function PageHeader({ eyebrow, title, description, actions }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function TimeRange({ value, onChange, ranges, label = 'Time range' }) {
  return (
    <div className="chips range-chips" role="group" aria-label={label}>
      {ranges.map((r) => (
        <button key={r.key} type="button" className="chip" aria-pressed={value === r.key} onClick={() => onChange(r.key)}>{r.label}</button>
      ))}
    </div>
  );
}

export function Meter({ value, max, formatValue, label, tone = 'info' }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className={`meter tone-${tone}`} role="img" aria-label={`${label}: ${formatValue ? formatValue(value) : value}`}>
      <div className="meter-track"><div className="meter-fill" style={{ width: `${ratio * 100}%` }} /></div>
      <div className="meter-meta">
        <span>{formatValue ? formatValue(value) : value}</span>
        {max ? <span className="muted">high-water {formatValue ? formatValue(max) : max}</span> : null}
      </div>
    </div>
  );
}

export function KeyValue({ items, className = '' }) {
  return (
    <dl className={`kv${className ? ' ' + className : ''}`}>
      {items.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
