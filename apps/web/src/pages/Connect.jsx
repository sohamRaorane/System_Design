// Connect a GitHub repository: choose a repo, review what will change, open the pull request,
// then wait for the first trace. Three real steps, so they are numbered.
import { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useData } from '../lib/hooks.js';
import { ago } from '../lib/format.js';
import { useRouter } from '../lib/router.jsx';
import { CopyButton, SetupSnippet } from '../components/Setup.jsx';

export function Connect({ pid, project, base, onChanged }) {
  const { path } = useRouter();
  const [linked, setLinked] = useState(null); // response of linkRepo
  const [pr, setPr] = useState(null);
  const repo = project?.repo;
  const step = pr || (repo?.pr_url && !linked) ? 3 : linked ? 2 : 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Connect a repository</h1>
          <p>We open a pull request that adds OpenTelemetry to your app. Nothing is changed until you merge it, and no secrets are written to the repository.</p>
        </div>
      </div>
      <ol className="steps" aria-label="Progress">
        {['Choose a repository', 'Review the changes', 'Deploy and see traces'].map((s, i) => (
          <li key={s} aria-current={step === i + 1 ? 'step' : undefined} className={step > i + 1 ? 'done' : ''}>{s}</li>
        ))}
      </ol>
      <div style={{ maxWidth: 860 }}>
        {step === 1 ? <ChooseRepo pid={pid} returnTo={path} onLinked={(r) => { setLinked(r); onChanged?.(); }} /> : null}
        {step === 2 ? <Review pid={pid} linked={linked} onBack={() => setLinked(null)} onOpened={(r) => { setPr(r); onChanged?.(); }} /> : null}
        {step === 3 ? <Finish pid={pid} project={project} pr={pr} base={base} onChangeRepo={async () => { await api.unlinkRepo(pid); setPr(null); setLinked(null); onChanged?.(); }} /> : null}
      </div>
    </>
  );
}

function GitHubProblem({ error, returnTo }) {
  if (error.body?.error === 'github_sign_in_required') {
    return (
      <div className="notice warn">
        <p style={{ marginBottom: 10 }}>You signed in without GitHub, so we cannot see your repositories.</p>
        <a className="btn" href={api.githubStartUrl(returnTo)}>Sign in with GitHub</a>
      </div>
    );
  }
  return <div className="notice bad" role="alert">{error.message}</div>;
}

function ChooseRepo({ pid, returnTo, onLinked }) {
  const inst = useData(() => api.installations(returnTo), [returnTo]);
  const [iid, setIid] = useState(null);
  const chosen = iid ?? inst.data?.installations?.[0]?.id ?? null;
  const repos = useData(() => (chosen ? api.installationRepos(chosen) : Promise.resolve({ repos: [] })), [chosen]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const shown = useMemo(() => (repos.data?.repos || []).filter((r) => r.full_name.toLowerCase().includes(filter.toLowerCase())), [repos.data, filter]);

  if (inst.error) return <GitHubProblem error={inst.error} returnTo={returnTo} />;
  if (!inst.data) return <p className="muted">Looking for your GitHub App installations…</p>;
  const installs = inst.data.installations;

  return (
    <section className="panel stack">
      {!installs.length ? (
        <>
          <p>First, install the Tracepipe GitHub App and choose which repositories it may access. You come back here when you are done.</p>
          <div><a className="btn" href={inst.data.install_url}>Install the GitHub App</a></div>
        </>
      ) : (
        <>
          <div className="row">
            {installs.length > 1 ? (
              <label className="field">Account
                <select value={chosen || ''} onChange={(e) => setIid(Number(e.target.value))}>
                  {installs.map((i) => <option key={i.id} value={i.id}>{i.account}</option>)}
                </select>
              </label>
            ) : <p className="small muted">Repositories the app can access in <b>{installs[0].account}</b>.</p>}
            <a className="small" href={inst.data.install_url} style={{ marginLeft: 'auto' }}>Add or remove repositories on GitHub</a>
          </div>
          <input aria-label="Filter repositories" placeholder="Filter repositories" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {repos.error ? <GitHubProblem error={repos.error} returnTo={returnTo} /> : null}
          {repos.loading && !repos.data ? <p className="muted">Loading repositories…</p> : null}
          {repos.data && !shown.length ? <p className="muted small">No repositories match. The app only sees repositories you granted it on GitHub.</p> : null}
          <ul className="repo-list">
            {shown.map((r) => (
              <li key={r.full_name}>
                <div>
                  <b>{r.full_name}</b>
                  <span className="small muted"> {r.language || ''}{r.private ? ', private' : ''}</span>
                </div>
                <button type="button" className="quiet" disabled={Boolean(busy)} onClick={async () => {
                  setBusy(r.full_name); setError(null);
                  try { onLinked(await api.linkRepo(pid, chosen, r.full_name)); } catch (err) { setError(err); } finally { setBusy(null); }
                }}>{busy === r.full_name ? 'Reading…' : 'Use this repository'}</button>
              </li>
            ))}
          </ul>
          {error ? <GitHubProblem error={error} returnTo={returnTo} /> : null}
        </>
      )}
    </section>
  );
}

function Review({ pid, linked, onBack, onOpened }) {
  const [service, setService] = useState(linked.repo.full_name.split('/')[1].toLowerCase());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <section className="panel stack">
      <h2>{linked.repo.full_name}</h2>
      <p>Detected: <b>{linked.stack.label}</b>. The pull request will change:</p>
      <ul className="changes">
        {linked.changes.map((c) => <li key={c.path}><code>{c.path}</code> {c.why}</li>)}
      </ul>
      {linked.notes.length ? (
        <div className="notice"><p style={{ fontWeight: 600, marginBottom: 6 }}>Good to know</p><ul style={{ margin: 0, paddingLeft: 18 }}>{linked.notes.map((n) => <li key={n}>{n}</li>)}</ul></div>
      ) : null}
      <label className="field">Service name shown in traces
        <input value={service} onChange={(e) => setService(e.target.value)} maxLength={60} style={{ maxWidth: 320 }} />
      </label>
      {error ? <div className="notice bad" role="alert">{error.message}</div> : null}
      <div className="row">
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try { onOpened(await api.openPullRequest(pid, service)); } catch (err) { setError(err); setBusy(false); }
        }}>{busy ? 'Opening pull request…' : 'Open pull request'}</button>
        <button type="button" className="quiet" onClick={onBack} disabled={busy}>Choose another repository</button>
      </div>
    </section>
  );
}

function Finish({ pid, project, pr, base, onChangeRepo }) {
  const { navigate } = useRouter();
  const [key, setKey] = useState(null);
  const live = useData(() => api.project(pid), [pid], { every: 3000 });
  const p = live.data?.project || project;
  const url = pr?.pull_request?.url || p?.repo?.pr_url;
  const receiving = Boolean(p?.first_trace_at);
  return (
    <div className="stack">
      <section className="panel stack">
        <h2>Pull request opened</h2>
        <p>Review and merge it on GitHub: <a href={url} target="_blank" rel="noreferrer">{url}</a></p>
        {pr?.notes?.length ? <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>{pr.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      </section>
      <section className="panel stack">
        <h2>Add these settings where your app runs</h2>
        <p className="small muted">Your hosting provider's environment settings (Render, Vercel, Docker, …). The key is created here and shown once.</p>
        {key ? (
          <div className="notice ok"><div className="row"><code style={{ wordBreak: 'break-all' }}>{key.value}</code><CopyButton text={key.value} /></div></div>
        ) : (
          <div><button type="button" className="quiet" onClick={async () => setKey((await api.createKey(pid, p?.repo?.full_name || 'app')).key)}>Create an ingest key for this app</button></div>
        )}
        <SetupSnippet setup={live.data?.setup || project?.setup} apiKey={key?.value} serviceName={pr?.service_name || (p?.repo?.full_name || 'app').split('/')[1]} />
      </section>
      <section className={'panel waiting' + (receiving ? ' ok' : '')} aria-live="polite">
        {receiving ? (
          <>
            <h2>Receiving traces</h2>
            <p>First trace arrived {ago(p.first_trace_at)}.</p>
            <div className="row"><button type="button" onClick={() => navigate(`${base}/overview`)}>Open the overview</button><button type="button" className="quiet" onClick={() => navigate(`${base}/traces`)}>See traces</button></div>
          </>
        ) : (
          <>
            <h2><span className="pulse" aria-hidden="true" /> Waiting for the first trace</h2>
            <p className="muted">Merge the pull request, set the variables, deploy, then open your app in a browser. This updates on its own.</p>
          </>
        )}
      </section>
      <div><button type="button" className="quiet" onClick={onChangeRepo}>Connect a different repository</button></div>
    </div>
  );
}
