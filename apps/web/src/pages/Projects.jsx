import { useState } from 'react';
import { api } from '../lib/api.js';
import { useData } from '../lib/hooks.js';
import { ago, num } from '../lib/format.js';
import { Link, useRouter } from '../lib/router.jsx';
import { SetupSnippet } from '../components/Setup.jsx';

export function Projects() {
  const { navigate } = useRouter();
  const list = useData(() => api.projects(), [], { every: 10000 });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api.createProject(name.trim());
      setCreated(r);
      setName('');
      list.refresh();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  if (created) {
    return (
      <>
        <div className="page-head"><div><h1>{created.project.name} is ready</h1><p>Your app sends traces with this ingest key. Copy it now: for your safety it is shown only once.</p></div></div>
        <div className="stack" style={{ maxWidth: 760 }}>
          <section className="panel">
            <h2>1. Connect a GitHub repository</h2>
            <p className="muted small" style={{ marginBottom: 12 }}>We open a pull request that adds OpenTelemetry to your app. You review and merge it.</p>
            <button type="button" onClick={() => navigate(`/p/${created.project.id}/connect`)}>Choose a repository</button>
          </section>
          <section className="panel">
            <h2>2. Or set it up by hand</h2>
            <p className="muted small" style={{ marginBottom: 12 }}>Add these environment variables where your app runs.</p>
            <SetupSnippet setup={created.setup} apiKey={created.key.value} />
          </section>
          <div className="row"><button type="button" className="quiet" onClick={() => navigate(`/p/${created.project.id}/overview`)}>Go to the project</button></div>
        </div>
      </>
    );
  }

  const projects = list.data?.projects || [];
  return (
    <>
      <div className="page-head">
        <div><h1>Projects</h1><p>A project collects traces from one application, however many services it has.</p></div>
      </div>
      {list.error ? <div className="notice bad" role="alert">{list.error.message}</div> : null}
      <div className="stack" style={{ maxWidth: 860 }}>
        <section className="panel">
          <h2>New project</h2>
          <form className="row" onSubmit={create} style={{ marginTop: 4 }}>
            <input aria-label="Project name" placeholder="e.g. Checkout app" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} style={{ flex: '1 1 240px' }} />
            <button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
          </form>
          {error ? <p className="small" style={{ color: 'var(--bad)', marginTop: 8 }}>{error}</p> : null}
        </section>
        {list.loading && !list.data ? <p className="muted">Loading projects…</p> : null}
        {list.data && !projects.length ? (
          <div className="empty"><p>No projects yet.</p><p className="small muted">Create one above to get an ingest key.</p></div>
        ) : null}
        {projects.length ? (
          <section className="panel">
            <table className="simple">
              <thead><tr><th>Project</th><th>Status</th><th>Spans / s</th><th>Repository</th></tr></thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td><Link to={`/p/${p.id}/overview`}>{p.name}</Link></td>
                    <td>{p.first_trace_at ? <><span className={'dot' + (p.live.spans_per_sec ? '' : ' idle')} /> {p.last_span_at ? `last span ${ago(p.last_span_at)}` : 'receiving'}</> : <span className="muted">waiting for the first trace</span>}</td>
                    <td>{num(p.live.spans_per_sec)}</td>
                    <td className="small">{p.repo ? p.repo.full_name : <span className="muted">not connected</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>
    </>
  );
}
