import { useEffect } from 'react';
import { api } from './lib/api.js';
import { useAuth } from './lib/auth.jsx';
import { useData } from './lib/hooks.js';
import { Link, match, useRouter } from './lib/router.jsx';
import { Logo } from './components/Logo.jsx';
import { Login } from './pages/Login.jsx';
import { Projects } from './pages/Projects.jsx';
import { Overview } from './pages/Overview.jsx';
import { Traces } from './pages/Traces.jsx';
import { Settings } from './pages/Settings.jsx';
import { Connect } from './pages/Connect.jsx';
import { LoadTest } from './pages/LoadTest.jsx';

export function Redirect({ to }) {
  const { navigate } = useRouter();
  useEffect(() => { navigate(to, { replace: true }); }, [to, navigate]);
  return null;
}

/** Pages that live inside one project: /p/:pid/<section>[/...]. */
const PROJECT_PAGES = {
  overview: (p) => <Overview {...p} />,
  traces: (p) => <Traces {...p} />,
  settings: (p) => <Settings {...p} />,
  connect: (p) => <Connect {...p} />,
  load: (p) => <LoadTest {...p} />,
};

export function App() {
  const { status } = useAuth();
  const { path, search } = useRouter();

  if (status === 'loading') return <div className="boot" aria-busy="true"><Logo /></div>;
  if (path === '/login') return status === 'signedIn' ? <Redirect to="/projects" /> : <Login />;
  if (status !== 'signedIn') return <Redirect to={`/login?next=${encodeURIComponent(path + search)}`} />;
  if (path === '/' || path === '/overview') return <Redirect to="/projects" />;
  return <Shell />;
}

function Shell() {
  const { path, navigate } = useRouter();
  const { user, signOut } = useAuth();
  const projects = useData(() => api.projects(), [], { every: 30000 });

  const m = match('/p/:pid/:section', path) || match('/p/:pid/:section/:rest', path);
  const pid = m?.pid;
  const project = useData(() => (pid ? api.project(pid) : Promise.resolve(null)), [pid], { every: 15000 });
  const proj = project.data ? { ...project.data.project, setup: project.data.setup } : null;
  const base = pid ? `/p/${pid}` : '';
  const known = projects.data?.projects?.some((p) => p.id === pid);
  useEffect(() => { if (pid && projects.data && !known) projects.refresh(); }, [pid, known]); // eslint-disable-line react-hooks/exhaustive-deps

  let page;
  if (path === '/projects') page = <Projects />;
  else if (m && PROJECT_PAGES[m.section]) {
    if (project.error) page = <div className="empty"><p>{project.error.status === 404 ? 'This project does not exist, or it belongs to someone else.' : project.error.message}</p><p><Link to="/projects">Back to your projects</Link></p></div>;
    else page = PROJECT_PAGES[m.section]({ pid, project: proj, base, traceId: m.section === 'traces' ? m.rest : undefined, onChanged: project.refresh });
  } else page = <div className="empty"><p>This page does not exist.</p><p><Link to="/projects">Go to your projects</Link></p></div>;

  return (
    <div className="shell">
      <aside className="rail">
        <Link to="/projects" className="brand"><Logo /> Tracepipe</Link>
        {projects.data?.projects?.length ? (
          <label className="field switcher">
            <span className="sr-only">Project</span>
            <select value={pid || ''} onChange={(e) => e.target.value && navigate(`/p/${e.target.value}/overview`)} aria-label="Project">
              <option value="">All projects</option>
              {projects.data.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        ) : null}
        <nav className="nav" aria-label="Main">
          {pid ? (
            <>
              <Link to={`${base}/overview`}>Overview</Link>
              <Link to={`${base}/traces`} activePrefix={`${base}/traces`}>Traces</Link>
              <Link to={`${base}/load`}>Load test</Link>
              {!proj?.is_default ? <Link to={`${base}/connect`}>Repository</Link> : null}
              <Link to={`${base}/settings`}>Settings</Link>
            </>
          ) : <Link to="/projects">Projects</Link>}
        </nav>
        <div className="rail-foot">
          <div className="user">
            {user?.avatar_url ? <img src={user.avatar_url} alt="" width="22" height="22" /> : null}
            <span>{user?.login}</span>
          </div>
          <button type="button" className="quiet" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="main">{page}</main>
    </div>
  );
}
