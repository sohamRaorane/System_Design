import { useEffect } from 'react';
import { Link, match, useRouter } from './lib/router.jsx';
import { Overview } from './pages/Overview.jsx';
import { Traces } from './pages/Traces.jsx';

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--signal)" />
      <path d="M5 20h6l3-9 4 13 3-7h6" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const PROJECT = 'default';

export function Redirect({ to }) {
  const { navigate } = useRouter();
  useEffect(() => { navigate(to, { replace: true }); }, [to, navigate]);
  return null;
}

export function App() {
  const { path } = useRouter();
  if (path === '/') return <Redirect to="/overview" />;
  const traceMatch = match('/traces/:id', path);

  let page;
  if (path === '/overview') page = <Overview project={PROJECT} base="" />;
  else if (path === '/traces' || traceMatch) page = <Traces project={PROJECT} base="" traceId={traceMatch?.id} />;
  else page = <div className="empty"><p>This page does not exist.</p><p><Link to="/overview">Go to the overview</Link></p></div>;

  return (
    <div className="shell">
      <aside className="rail">
        <Link to="/overview" className="brand"><Logo /> Tracepipe</Link>
        <nav className="nav" aria-label="Main">
          <Link to="/overview">Overview</Link>
          <Link to="/traces" activePrefix="/traces">Traces</Link>
        </nav>
      </aside>
      <main className="main">{page}</main>
    </div>
  );
}
