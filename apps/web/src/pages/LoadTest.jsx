import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useData } from '../lib/hooks.js';
import { ago, ms, num } from '../lib/format.js';
import { useRouter } from '../lib/router.jsx';
import { CopyButton } from '../components/Setup.jsx';
import { LatencyLine, RequestBars, RunTable } from '../components/RunCharts.jsx';

const DURATIONS = [15, 30, 60, 120];
const VERIFIED_BY = {
  telemetry: 'your app already sends traces from this address',
  token_file: 'the address serves this project\'s verification token',
  local_development: 'it is on this computer (development only)',
};

export function LoadTest({ pid, project, base }) {
  const { navigate } = useRouter();
  const history = useData(() => api.loadtests(pid), [pid], { every: 5000 });
  const limits = useData(() => api.loadtestLimits(pid), [pid]);
  const [current, setCurrent] = useState(null);
  const activeId = current || history.data?.active || null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Load test</h1>
          <p>Send traffic to your app and watch how the pipeline and your services cope. Every request becomes a trace you can open.</p>
        </div>
      </div>
      <div className="stack" style={{ maxWidth: 980 }}>
        {activeId ? <LiveRun pid={pid} id={activeId} onClose={() => { setCurrent(null); history.refresh(); }} onTraces={(id) => navigate(`${base}/traces?loadtest=${id}`)} /> : null}
        {!activeId ? (
          <div className="grid-2">
            <HttpTest pid={pid} limits={limits.data} onStarted={(id) => setCurrent(id)} />
            <DemoTraffic pid={pid} onStarted={(id) => setCurrent(id)} />
          </div>
        ) : null}
        <History runs={history.data?.runs || []} onOpen={(id) => setCurrent(id)} onTraces={(id) => navigate(`${base}/traces?loadtest=${id}`)} />
      </div>
    </>
  );
}

function HttpTest({ pid, limits, onStarted }) {
  const [url, setUrl] = useState('');
  const [rps, setRps] = useState(10);
  const [duration, setDuration] = useState(30);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setCheck(null); }, [url]);

  const verify = async () => {
    setBusy(true); setError('');
    try { setCheck(await api.verifyTarget(pid, url.trim())); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const start = async () => {
    setBusy(true); setError('');
    try { onStarted((await api.startLoadTest(pid, { url: url.trim(), rps, duration_s: duration })).run.id); } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <section className="panel stack">
      <h2>Test your deployed app</h2>
      <label className="field">Address to test
        <input type="url" placeholder="https://your-app.onrender.com/api/products" value={url} onChange={(e) => setUrl(e.target.value)} required />
      </label>
      <label className="field">{rps} requests a second
        <input type="range" min="1" max={limits?.max_rps || 50} value={rps} onChange={(e) => setRps(Number(e.target.value))} />
      </label>
      <label className="field">For
        <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} style={{ maxWidth: 200 }}>
          {DURATIONS.filter((d) => d <= (limits?.max_duration_s || 120)).map((d) => <option key={d} value={d}>{d} seconds</option>)}
        </select>
      </label>
      {check?.verified ? (
        <div className="notice ok">You can test {check.host}: {VERIFIED_BY[check.method] || check.method}.</div>
      ) : check ? (
        <div className="notice warn stack" style={{ gap: 8 }}>
          <p>We only send load to apps you own. Either let your instrumented app send a few traces first (we then recognise its address), or publish this token at <code>{check.host}/.well-known/otel-pipeline.txt</code>:</p>
          <div className="row"><code>{check.token}</code><CopyButton text={check.token} /></div>
          <p className="small">With the demo shop, set <code>OTEL_PIPELINE_VERIFY_TOKEN</code> to this value.</p>
        </div>
      ) : null}
      {error ? <div className="notice bad" role="alert">{error}</div> : null}
      <div className="row">
        {check?.verified
          ? <button type="button" onClick={start} disabled={busy}>{busy ? 'Starting…' : `Start: ${num(rps * duration)} requests`}</button>
          : <button type="button" onClick={verify} disabled={busy || !url.trim()}>{busy ? 'Checking…' : 'Check access'}</button>}
      </div>
    </section>
  );
}

function DemoTraffic({ pid, onStarted }) {
  const [rps, setRps] = useState(5);
  const [duration, setDuration] = useState(60);
  const [error, setError] = useState('');
  return (
    <section className="panel stack">
      <h2>Simulated traffic</h2>
      <p className="muted small">No app needed. We generate realistic requests across five services (gateway, auth, catalog, inventory, payments), including payment failures and slow calls, and feed them through this project's pipeline.</p>
      <label className="field">{rps} requests a second
        <input type="range" min="1" max="20" value={rps} onChange={(e) => setRps(Number(e.target.value))} />
      </label>
      <label className="field">For
        <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} style={{ maxWidth: 200 }}>
          {DURATIONS.map((d) => <option key={d} value={d}>{d} seconds</option>)}
        </select>
      </label>
      {error ? <div className="notice bad" role="alert">{error}</div> : null}
      <div><button type="button" className="quiet" onClick={async () => {
        setError('');
        try { onStarted((await api.startDemoTraffic(pid, { rps, duration_s: duration })).run.id); } catch (err) { setError(err.message); }
      }}>Start simulated traffic</button></div>
    </section>
  );
}

function LiveRun({ pid, id, onClose, onTraces }) {
  const r = useData(() => api.loadtest(pid, id), [pid, id], { every: 1000 });
  const run = r.data?.run;
  if (!run) return <section className="panel"><p className="muted">Loading the run…</p></section>;
  const running = run.status === 'running';
  const s = run.summary;
  const t = run.timeline || [];
  const sent = s?.sent ?? t.reduce((a, p) => a + p.sent, 0);
  const failed = s?.failed ?? t.reduce((a, p) => a + (p.failed || 0), 0);
  return (
    <section className="panel stack" aria-live="polite">
      <div className="wf-head">
        <div>
          <h2>{run.kind === 'demo' ? 'Simulated traffic' : run.target_url}</h2>
          <p className="small muted">{run.rps} requests a second for {run.duration_s} seconds. {running ? `Running: ${t.length} of ${run.duration_s} seconds done.` : `${run.status === 'completed' ? 'Finished' : run.status === 'stopped' ? 'Stopped early' : 'Failed'} ${ago(run.finished_at)}.`}</p>
        </div>
        <div className="row">
          {running ? <button type="button" className="danger" onClick={() => api.stopLoadTest(pid, id).then(r.refresh)}>Stop</button> : <button type="button" className="quiet" onClick={onClose}>New test</button>}
        </div>
      </div>
      <div className="facts">
        <span><b>{num(sent)}</b> {run.kind === 'demo' ? 'traces generated' : 'requests sent'}</span>
        <span><b style={{ color: failed ? 'var(--bad)' : undefined }}>{sent ? Math.round((failed / sent) * 1000) / 10 : 0}%</b> failed</span>
        {run.kind !== 'demo' ? <span><b>{ms(s?.p95 ?? t.at(-1)?.p95)}</b> p95</span> : null}
        {s?.codes ? <span>{Object.entries(s.codes).map(([c, n]) => `${c === 'network' ? 'no response' : c}: ${num(n)}`).join(', ')}</span> : null}
      </div>
      {run.error ? <div className="notice bad">{run.error}</div> : null}
      <div className={run.kind === 'demo' ? '' : 'grid-2'}>
        <RequestBars points={t} slots={run.duration_s} />
        {run.kind !== 'demo' ? <LatencyLine points={t} slots={run.duration_s} /> : null}
      </div>
      <RunTable points={t} />
      <div className="row">
        <button type="button" className="quiet" onClick={() => onTraces(run.id)}>See the traces from this run</button>
        <span className="small muted">Failed and slow requests are all kept; healthy ones are sampled.</span>
      </div>
    </section>
  );
}

function History({ runs, onOpen, onTraces }) {
  if (!runs.length) return null;
  return (
    <section className="panel">
      <h2>Earlier runs</h2>
      <table className="simple">
        <thead><tr><th>When</th><th>Target</th><th>Load</th><th>Result</th><th /></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{ago(r.started_at)}</td>
              <td style={{ wordBreak: 'break-all' }}>{r.kind === 'demo' ? 'Simulated traffic' : r.target_url}</td>
              <td>{r.rps}/s for {r.duration_s} s</td>
              <td>{r.status === 'running' ? 'running' : r.summary ? `${num(r.summary.sent)} sent, ${num(r.summary.failed ?? r.summary.kinds?.error ?? 0)} failed` : r.status}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button type="button" className="quiet" onClick={() => onOpen(r.id)}>Details</button>{' '}
                <button type="button" className="quiet" onClick={() => onTraces(r.id)}>Traces</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
