// Administrators only: pipeline-wide settings and live failure drills. Each drill says what
// to watch on the overview, so the recovery mechanisms in the architecture can be seen working.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useData, usePrevious } from '../lib/hooks.js';
import { pipelineStages } from '../lib/health.js';
import { FlowStrip } from '../components/FlowStrip.jsx';

const DRILLS = [
  { key: 'storage_down', title: 'Storage goes down', what: 'Writes to the database fail.', watch: 'Store turns red: batches wait safely, retries back off, the circuit breaker opens. Switch it off and everything waiting is written, nothing lost.' },
  { key: 'slow_drain', title: 'Collector falls behind', what: 'The queue drains at a crawl.', watch: 'Queue fills up: at the soft limit fewer healthy traces are kept (errors still are); at the hard limit senders get 429 and retry.' },
  { key: 'archive_down', title: 'Archive storage fails', what: 'Uploads to cold storage fail.', watch: 'Archive warns; old traces simply stay in hot storage and the move is retried later.' },
];

const GROUPS = [
  { title: 'Sampling', keys: [
    ['normal_sampling_rate', 'Share of healthy traces kept (0–1)'],
    ['error_sampling_rate', 'Share of failed traces kept (0–1)'],
    ['latency_threshold_ms', 'Slow when longer than (ms)'],
    ['keep_incomplete_traces', 'Keep incomplete traces'],
    ['backpressure_sampling_factor', 'Healthy-trace share multiplier while the queue is busy'],
  ] },
  { title: 'Assembling traces', keys: [
    ['trace_timeout_ms', 'Give up waiting for spans after (ms)'],
    ['settle_window_ms', 'Quiet time before a trace counts as finished (ms)'],
    ['max_spans_per_trace', 'Most spans kept per trace'],
    ['max_open_traces', 'Most traces assembled at once'],
  ] },
  { title: 'Queue and batches', keys: [
    ['queue_soft_limit', 'Queue size where sampling tightens'],
    ['queue_hard_limit', 'Queue size where new spans are refused'],
    ['batch_flush_size', 'Traces per database write'],
    ['batch_flush_interval_ms', 'Write at least every (ms)'],
    ['max_pending_batches', 'Batches kept in memory during an outage'],
  ] },
  { title: 'Retries', keys: [
    ['retry_base_ms', 'First retry after (ms)'],
    ['retry_max_ms', 'Longest wait between retries (ms)'],
    ['breaker_failure_threshold', 'Failures before pausing writes'],
    ['breaker_cooldown_ms', 'Pause length (ms)'],
  ] },
  { title: 'Retention', keys: [
    ['hot_retention_days', 'Searchable for (days)'],
    ['cold_retention_days', 'Archived for (days)'],
    ['archive_interval_ms', 'Archive check every (ms)'],
    ['archive_batch_size', 'Traces per archive run'],
  ] },
];

export function Admin() {
  const metrics = useData(() => api.pipeline(), [], { every: 2000 });
  const prev = usePrevious(metrics.data);
  const stages = useMemo(() => pipelineStages(metrics.data, prev), [metrics.data, prev]);
  const faults = useData(() => api.faults(), [], { every: 4000 });
  const config = useData(() => api.adminConfig(), []);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (config.data) setForm({ ...config.data.config }); }, [config.data]);

  if (config.error?.status === 403 || config.error?.status === 401) {
    return <div className="empty"><p>This page is for administrators.</p><p className="small muted">Ask the operator to add your GitHub login to ADMIN_GITHUB_LOGINS.</p></div>;
  }

  const toggle = async (key, value) => { await api.setFaults({ [key]: value }); faults.refresh(); };
  const save = async (e) => {
    e.preventDefault();
    setMsg(null);
    const patch = {};
    for (const [k, v] of Object.entries(form)) if (v !== config.data.config[k]) patch[k] = typeof config.data.config[k] === 'number' ? Number(v) : v;
    if (!Object.keys(patch).length) return setMsg({ ok: true, text: 'Nothing changed.' });
    try {
      const r = await api.updateAdminConfig(patch);
      setMsg({ ok: true, text: `Saved as version ${r.version}. Applies immediately.` });
      config.refresh();
    } catch (err) {
      setMsg({ ok: false, text: err.body?.errors?.map((x) => `${x.field}: ${x.reason}`).join('; ') || err.message });
    }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Pipeline admin</h1><p>Settings that apply to every project, and drills that break one part on purpose so you can watch the pipeline recover.</p></div>
      </div>
      {metrics.data ? <FlowStrip stages={stages} /> : null}
      <div className="stack" style={{ maxWidth: 980 }}>
        <section className="panel stack">
          <h2>Failure drills</h2>
          <p className="small muted">Turn one on, watch the strip above for a minute, then turn it off. Use demo traffic to have spans flowing.</p>
          {DRILLS.map((d) => {
            const on = Boolean(faults.data?.faults?.[d.key]);
            return (
              <div key={d.key} className={'drill' + (on ? ' on' : '')}>
                <div>
                  <h3>{d.title}</h3>
                  <p className="small">{d.what} <span className="muted">{d.watch}</span></p>
                </div>
                <button type="button" className={on ? 'danger' : 'quiet'} aria-pressed={on} onClick={() => toggle(d.key, !on)}>{on ? 'Turn off' : 'Turn on'}</button>
              </div>
            );
          })}
          <div className="row">
            <button type="button" className="quiet" onClick={() => api.flush()}>Write waiting batches now</button>
            <button type="button" className="quiet" onClick={() => api.runArchive()}>Run the archive now</button>
          </div>
        </section>

        {form ? (
          <form className="panel stack" onSubmit={save}>
            <h2>Pipeline settings</h2>
            <p className="small muted">Projects can override sampling and retention in their own settings.</p>
            {GROUPS.map((g) => (
              <fieldset key={g.title} className="cfg-group">
                <legend>{g.title}</legend>
                {g.keys.map(([k, label]) => (
                  <label key={k} className="cfg-row">
                    <span>{label}<code className="muted"> {k}</code></span>
                    {typeof form[k] === 'boolean'
                      ? <input type="checkbox" checked={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
                      : <input type="number" step="any" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />}
                  </label>
                ))}
              </fieldset>
            ))}
            <div className="row"><button type="submit">Save pipeline settings</button>{msg ? <span className="small" role="status" style={{ color: msg.ok ? 'var(--signal)' : 'var(--bad)' }}>{msg.text}</span> : null}</div>
          </form>
        ) : null}
      </div>
    </>
  );
}
