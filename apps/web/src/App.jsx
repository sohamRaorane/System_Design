import { useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { useAuth } from './lib/auth.jsx';
import { useData } from './lib/hooks.js';
import { Link, match, useRouter } from './lib/router.jsx';
import { Logo } from './components/Logo.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { Topbar } from './components/Topbar.jsx';
import { Login } from './pages/Login.jsx';
import { Projects } from './pages/Projects.jsx';
import { Overview } from './pages/Overview.jsx';
import { Traces } from './pages/Traces.jsx';
import { Services } from './pages/Services.jsx';
import { Settings } from './pages/Settings.jsx';
import { Connect } from './pages/Connect.jsx';
import { LoadTest } from './pages/LoadTest.jsx';
import { Admin } from './pages/Admin.jsx';
import { Pipeline } from './pages/Pipeline.jsx';

export function Redirect({ to }) {
  const { navigate } = useRouter();
  useEffect(() => { navigate(to, { replace: true }); }, [to, navigate]);
  return null;
}

/** Pages that live inside one project: /p/:pid/<section>[/...]. */
const PROJECT_PAGES = {
  overview: (p) => <Overview {...p} />,
  traces: (p) => <Traces {...p} />,
  services: (p) => <Services {...p} />,
  settings: (p) => <Settings {...p} />,
  connect: (p) => <Connect {...p} />,
  load: (p) => <LoadTest {...p} />,
};

const GLOBAL_PAGES = {
  '/projects': <Projects />,
  '/pipeline': <Pipeline />,
  '/admin': <Admin />,
};

export function App() {
  const { status } = useAuth();
  const { path, search } = useRouter();

  if (status === 'loading') return <div className="boot" aria-busy="true"><Logo /><span className="sr-only">Loading session</span></div>;
  if (path === '/login') return status === 'signedIn' ? <Redirect to="/projects" /> : <Login />;
  if (status !== 'signedIn') return <Redirect to={`/login?next=${encodeURIComponent(path + search)}`} />;
  if (path === '/' || path === '/overview') return <Redirect to="/projects" />;
  return <Shell />;
}

function Shell() {
  const { path } = useRouter();
  const { user, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const projects = useData(() => api.projects(), [], { every: 30000 });

  const m = match('/p/:pid/:section', path) || match('/p/:pid/:section/:rest', path);
  const pid = m?.pid;
  const project = useData(() => (pid ? api.project(pid) : Promise.resolve(null)), [pid], { every: 15000 });
  const proj = project.data ? { ...project.data.project, setup: project.data.setup } : null;
  const base = pid ? `/p/${pid}` : '';
  const section = m?.section || path.split('/').filter(Boolean)[0] || '';
  const known = projects.data?.projects?.some((p) => p.id === pid);
  useEffect(() => { if (pid && projects.data && !known) projects.refresh(); }, [pid, known]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setMenuOpen(false); }, [path]);

  let page;
  if (GLOBAL_PAGES[path]) page = GLOBAL_PAGES[path];
  else if (m && PROJECT_PAGES[m.section]) {
    if (project.error) {
      page = (
        <div className="empty panel">
          <p className="empty-title">{project.error.status === 404 ? 'This project does not exist, or it belongs to someone else.' : project.error.message}</p>
          <p><Link to="/projects">Back to your projects</Link></p>
        </div>
      );
    } else {
      page = PROJECT_PAGES[m.section]({ pid, project: proj, base, traceId: m.section === 'traces' ? m.rest : undefined, onChanged: project.refresh });
    }
  } else if (path === '/projects') {
    page = <Projects />;
  } else {
    page = (
      <div className="empty panel">
        <p className="empty-title">This page does not exist.</p>
        <p><Link to="/projects">Go to your projects</Link></p>
      </div>
    );
  }

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <div className={`shell${menuOpen ? ' nav-open' : ''}`}>
        <Sidebar
          projects={projects}
          pid={pid}
          project={proj}
          user={user}
          menuOpen={menuOpen}
          onClose={() => setMenuOpen(false)}
          onSignOut={signOut}
        />
        <div className="main-column">
          <Topbar pid={pid} project={proj} section={section} menuOpen={menuOpen} onMenu={() => setMenuOpen((v) => !v)} />
          <main className="main" id="main">
            {page}
          </main>
          <footer className="app-footer">
            <span>Tracepipe · OpenTelemetry trace pipeline</span>
            <span className="muted">Metrics polled every 2s · history limited to this browser session</span>
          </footer>
        </div>
      </div>
    </>
  );
}
