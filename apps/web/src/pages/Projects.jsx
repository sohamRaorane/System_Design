import { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useData } from '../lib/hooks.js';
import { ago, num } from '../lib/format.js';
import { Link, useRouter } from '../lib/router.jsx';
import { SetupSnippet } from '../components/Setup.jsx';
import { EmptyState, ErrorNotice, MetricCard, PageHeader, Panel, StatusBadge } from '../components/ui.jsx';

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

  const projects = list.data?.projects || [];
  const totals = useMemo(() => projects.reduce((acc, p) => ({
    active: acc.active + (p.live?.spans_per_sec ? 1 : 0),
    waiting: acc.waiting + (p.first_trace_at ? 0 : 1),
    repos: acc.repos + (p.repo ? 1 : 0),
  }), { active: 0, waiting: 0, repos: 0 }), [projects]);

  if (created) {
    return (
      <>
        <PageHeader
          eyebrow="Project created"
          title={`${created.project.name} is ready`}
          description="Your app sends traces with this ingest key. Copy it now: for your safety it is shown only once."
        />
        <div className="stack narrow-stack">
          <Panel title="1. Connect a GitHub repository" subtitle="We open a pull request that adds OpenTelemetry to your app. You review and merge it.">
            <button type="button" onClick={() => navigate(`/p/${created.project.id}/connect`)}>Choose a repository</button>
          </Panel>
          <Panel title="2. Or set it up by hand" subtitle="Add these environment variables where your app runs.">
            <SetupSnippet setup={created.setup} apiKey={created.key.value} />
          </Panel>
          <div className="row">
            <button type="button" className="quiet" onClick={() => navigate(`/p/${created.project.id}/overview`)}>Go to the project</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Projects"
        description="A project collects traces from one application, however many services it has. Pick one to open its observability dashboard."
        actions={<StatusBadge tone={list.error ? 'bad' : 'info'}>{list.loading && !list.data ? 'Loading' : `${num(projects.length)} project${projects.length === 1 ? '' : 's'}`}</StatusBadge>}
      />

      <ErrorNotice error={list.error} />

      <div className="metric-grid metric-grid-4">
        <MetricCard label="Projects" value={num(projects.length)} unit="total" hint="Owned by your account" tone="info" />
        <MetricCard label="Active now" value={num(totals.active)} unit="receiving" hint="Spans accepted in the last few seconds" tone={totals.active ? 'ok' : 'idle'} />
        <MetricCard label="Awaiting first trace" value={num(totals.waiting)} unit="projects" hint="Set up an app or run simulated traffic" tone={totals.waiting ? 'warn' : 'ok'} />
        <MetricCard label="Repositories connected" value={num(totals.repos)} unit="apps" hint="Instrumented through the GitHub App" tone="neutral" />
      </div>

      <Panel title="New project" subtitle="Each project gets its own ingest key and pipeline settings.">
        <form className="row" onSubmit={create}>
          <input aria-label="Project name" placeholder="e.g. Checkout app" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} style={{ flex: '1 1 280px' }} />
          <button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
        </form>
        {error ? <p className="small text-bad" style={{ marginTop: 8 }}>{error}</p> : null}
      </Panel>

      {list.loading && !list.data ? <p className="muted">Loading projects…</p> : null}

      <Panel title="All projects" subtitle="Live rates come from the collector's own counters.">
        {list.data && !projects.length ? (
          <EmptyState title="No projects yet.">Create one above to get an ingest key.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="simple data-table projects-table">
              <thead>
                <tr><th>Project</th><th>Status</th><th className="num">Spans / s</th><th>Last span</th><th>Repository</th><th /></tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td><Link to={`/p/${p.id}/overview`} className="project-link">{p.name}</Link><div className="small muted mono">{p.id === 'default' ? 'default project' : p.id}</div></td>
                    <td>
                      {p.first_trace_at
                        ? <StatusBadge tone={p.live?.spans_per_sec ? 'ok' : 'idle'}>{p.live?.spans_per_sec ? 'Receiving' : 'Idle'}</StatusBadge>
                        : <StatusBadge tone="warn">Waiting for first trace</StatusBadge>}
                    </td>
                    <td className="num">{num(p.live?.spans_per_sec)}</td>
                    <td className="small">{p.last_span_at ? ago(p.last_span_at) : <span className="muted">never</span>}</td>
                    <td className="small">{p.repo ? p.repo.full_name : <span className="muted">not connected</span>}</td>
                    <td className="num"><Link to={`/p/${p.id}/overview`} className="link-button">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
