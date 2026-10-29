import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useData } from '../lib/hooks.js';
import { ago } from '../lib/format.js';
import { useRouter } from '../lib/router.jsx';
import { CopyButton, SetupSnippet } from '../components/Setup.jsx';

export function Settings({ pid, project, onChanged }) {
  const { navigate } = useRouter();
  const stats = useData(() => api.stats(pid), [pid]);
  const eff = stats.data?.effective;
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (!eff || !project) return;
    setForm({
      name: project.name,
      rate: Math.round((project.settings.normal_sampling_rate ?? eff.normal_sampling_rate) * 100),
      latency: project.settings.latency_threshold_ms ?? eff.latency_threshold_ms,
      retention: project.settings.hot_retention_days ?? eff.hot_retention_days,
    });
  }, [eff, project]);

  const save = async (e) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api.updateProject(pid, {
        ...(project.is_default ? {} : { name: form.name.trim() }),
        settings: { normal_sampling_rate: form.rate / 100, latency_threshold_ms: Number(form.latency), hot_retention_days: Number(form.retention) },
      });
      setMsg({ kind: 'ok', text: 'Saved. New traces use these settings straight away.' });
      onChanged?.();
    } catch (err) {
      setMsg({ kind: 'bad', text: err.body?.errors?.map((x) => `${x.field}: ${x.reason}`).join('; ') || err.message });
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${project.name}" and all of its traces? This cannot be undone.`)) return;
    await api.deleteProject(pid);
    navigate('/projects', { replace: true });
  };

  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><p>How this project keeps traces, and the keys your app uses to send them.</p></div></div>
      <div className="stack" style={{ maxWidth: 860 }}>
        {form ? (
          <form className="panel stack" onSubmit={save}>
            <h2>Sampling and storage</h2>
            {!project.is_default ? (
              <label className="field">Project name
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} required />
              </label>
            ) : null}
            <label className="field">Keep {form.rate}% of healthy requests
              <input type="range" min="0" max="100" step="1" value={form.rate} onChange={(e) => setForm({ ...form, rate: Number(e.target.value) })} />
              <span className="small muted">Failed requests and slow requests are always kept, whatever this says. Lower it to save storage on busy apps.</span>
            </label>
            <label className="field">A request is slow when it takes longer than (ms)
              <input type="number" min="1" max="600000" step="1" value={form.latency} onChange={(e) => setForm({ ...form, latency: e.target.value })} style={{ maxWidth: 180 }} />
              <span className="small muted">Slow requests are always kept and marked “Slow”.</span>
            </label>
            <label className="field">Keep traces searchable for (days)
              <input type="number" min="0.001" max="36500" step="any" value={form.retention} onChange={(e) => setForm({ ...form, retention: e.target.value })} style={{ maxWidth: 180 }} />
              <span className="small muted">After this they move to the archive: still readable by trace id, at a lower cost.</span>
            </label>
            <div className="row"><button type="submit">Save settings</button>{msg ? <span className="small" style={{ color: msg.kind === 'ok' ? 'var(--signal)' : 'var(--bad)' }} role="status">{msg.text}</span> : null}</div>
          </form>
        ) : <p className="muted">Loading…</p>}

        <Keys pid={pid} />

        <section className="panel">
          <h2>Send traces from your app</h2>
          <p className="muted small" style={{ marginBottom: 12 }}>Use one of your ingest keys in place of the placeholder.</p>
          <SetupSnippet setup={project?.setup} />
        </section>

        {!project?.is_default ? (
          <section className="panel">
            <h2>Delete project</h2>
            <p className="muted small" style={{ margin: '0 0 12px' }}>Removes the project, its keys and its stored traces.</p>
            <button type="button" className="danger" onClick={remove}>Delete this project</button>
          </section>
        ) : null}
      </div>
    </>
  );
}

function Keys({ pid }) {
  const keys = useData(() => api.keys(pid), [pid]);
  const [fresh, setFresh] = useState(null);
  const [label, setLabel] = useState('');
  const create = async (e) => {
    e.preventDefault();
    const r = await api.createKey(pid, label.trim() || null);
    setFresh(r.key); setLabel(''); keys.refresh();
  };
  const revoke = async (k) => {
    if (!window.confirm(`Revoke key ${k.prefix}…? Apps using it stop sending traces immediately.`)) return;
    await api.revokeKey(pid, k.id); keys.refresh();
  };
  return (
    <section className="panel">
      <h2>Ingest keys</h2>
      {fresh ? (
        <div className="notice ok" style={{ marginBottom: 12 }}>
          <p style={{ marginBottom: 8 }}>New key. Copy it now: it is not shown again.</p>
          <div className="row"><code style={{ wordBreak: 'break-all' }}>{fresh.value}</code><CopyButton text={fresh.value} /></div>
        </div>
      ) : null}
      <table className="simple">
        <thead><tr><th>Key</th><th>Label</th><th>Last used</th><th /></tr></thead>
        <tbody>
          {(keys.data?.keys || []).map((k) => (
            <tr key={k.id} style={k.revoked_at ? { opacity: 0.55 } : undefined}>
              <td><code>otk_{k.prefix}_…</code></td>
              <td>{k.label || <span className="muted">–</span>}</td>
              <td>{k.revoked_at ? 'revoked' : k.last_used_at ? ago(k.last_used_at) : 'never'}</td>
              <td style={{ textAlign: 'right' }}>{!k.revoked_at ? <button type="button" className="quiet" onClick={() => revoke(k)}>Revoke</button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="row" onSubmit={create} style={{ marginTop: 12 }}>
        <input placeholder="Label (optional), e.g. production" aria-label="Key label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        <button type="submit" className="quiet">Create key</button>
      </form>
    </section>
  );
}
