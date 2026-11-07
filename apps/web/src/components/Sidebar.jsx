import { Link, useRouter } from '../lib/router.jsx';
import { usePipeline } from '../lib/pipeline.js';
import { Logo } from './Logo.jsx';
import { ThemeSwitch } from './ThemeSwitch.jsx';
import { StatusBadge } from './ui.jsx';

function NavLink({ to, children, icon, activePrefix }) {
  return (
    <Link to={to} activePrefix={activePrefix} className="nav-link">
      <span className="nav-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
      </span>
      <span>{children}</span>
    </Link>
  );
}

const ICONS = {
  projects: <path d="M4 6h16M4 12h16M4 18h10" />,
  overview: <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />,
  traces: <path d="M4 18V6m5 12V9m5 9V4m5 14v-7" />,
  services: <path d="M5 5h5v5H5zM14 5h5v5h-5zM9.5 14h5v5h-5zM10 7.5h4M7.5 10v2.5h9V10" />,
  load: <path d="M13 2 4 14h6l-1 8 9-12h-6z" />,
  repo: <path d="M6 3v12a3 3 0 0 0 3 3h9M6 7h12M15 3v8" />,
  settings: <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8 4a8 8 0 0 1-.1 1.2l2 1.6-2 3.4-2.4-1a8 8 0 0 1-2 1.2L15 21h-4l-.5-2.6a8 8 0 0 1-2-1.2l-2.4 1-2-3.4 2-1.6A8 8 0 0 1 6 12" />,
  pipeline: <path d="M4 12h4l2-7 4 14 2-7h4" />,
  admin: <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />,
};

export function Sidebar({ projects, pid, project, user, menuOpen, onClose, onSignOut }) {
  const { navigate } = useRouter();
  const pipeline = usePipeline();
  const base = pid ? `/p/${pid}` : '';
  const close = () => onClose?.();
  const list = projects.data?.projects || [];

  const globalStatus = pipeline.error && !pipeline.data
    ? { tone: 'bad', text: 'Collector unreachable' }
    : !pipeline.data
      ? { tone: 'idle', text: 'Connecting to collector' }
      : pipeline.data.queue.queue_state === 'FULL' || pipeline.data.batching.breaker_state === 'open'
        ? { tone: 'bad', text: 'Pipeline needs attention' }
        : pipeline.data.queue.queue_state === 'SOFT' || pipeline.data.batching.pending_batches > 2
          ? { tone: 'warn', text: 'Pipeline warning' }
          : { tone: 'ok', text: 'Pipeline healthy' };

  return (
    <>
      {menuOpen ? <button type="button" className="rail-scrim" aria-label="Close navigation" onClick={close} /> : null}
      <aside className={`rail${menuOpen ? ' open' : ''}`} id="app-navigation">
        <div className="rail-brand-row">
          <Link to="/projects" className="brand">
            <Logo />
            <span>Tracepipe</span>
          </Link>
          <button type="button" className="rail-close quiet" aria-label="Close navigation" onClick={close}>×</button>
        </div>

        {list.length ? (
          <label className="field switcher">
            <span className="nav-label">Project</span>
            <select
              value={pid || ''}
              onChange={(e) => { if (e.target.value) { navigate(`/p/${e.target.value}/overview`); close(); } }}
              aria-label="Project"
            >
              <option value="">All projects</option>
              {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        ) : null}

        <nav className="nav" aria-label="Main">
          <div className="nav-group">
            <span className="nav-label">Observe</span>
            {pid ? (
              <>
                <NavLink to={`${base}/overview`} icon={ICONS.overview} activePrefix={`${base}/overview`}>Overview</NavLink>
                <NavLink to={`${base}/traces`} icon={ICONS.traces} activePrefix={`${base}/traces`}>Traces</NavLink>
                <NavLink to={`${base}/services`} icon={ICONS.services} activePrefix={`${base}/services`}>Services</NavLink>
              </>
            ) : (
              <NavLink to="/projects" icon={ICONS.projects} activePrefix="/projects">Projects</NavLink>
            )}
          </div>

          {pid ? (
            <div className="nav-group">
              <span className="nav-label">Operate</span>
              <NavLink to={`${base}/load`} icon={ICONS.load} activePrefix={`${base}/load`}>Load test</NavLink>
              {!project?.is_default ? <NavLink to={`${base}/connect`} icon={ICONS.repo} activePrefix={`${base}/connect`}>Repository</NavLink> : null}
              <NavLink to={`${base}/settings`} icon={ICONS.settings} activePrefix={`${base}/settings`}>Settings</NavLink>
            </div>
          ) : null}

          <div className="nav-group">
            <span className="nav-label">Platform</span>
            <NavLink to="/pipeline" icon={ICONS.pipeline} activePrefix="/pipeline">Pipeline</NavLink>
            {user?.admin ? <NavLink to="/admin" icon={ICONS.admin} activePrefix="/admin">Admin</NavLink> : null}
          </div>
        </nav>

        <div className="rail-foot">
          <div className="system-status" aria-live="polite">
            <StatusBadge tone={globalStatus.tone} pulse={globalStatus.tone === 'ok'}>{globalStatus.text}</StatusBadge>
            {pipeline.data ? (
              <span className="system-status-meta">
                {pipeline.data.ingestion.ingest_rate_per_sec} spans/s · queue {pipeline.data.queue.queue_depth}
              </span>
            ) : null}
          </div>
          <div className="user">
            {user?.avatar_url ? <img src={user.avatar_url} alt="" width="26" height="26" onError={(e) => { e.currentTarget.style.display = 'none'; }} /> : <span className="user-fallback" aria-hidden="true">{(user?.login || '?').slice(0, 1).toUpperCase()}</span>}
            <div className="user-meta">
              <span className="user-name">{user?.login}</span>
              <span className="user-role">{user?.admin ? 'Administrator' : 'Developer'}</span>
            </div>
          </div>
          <ThemeSwitch />
          <button type="button" className="quiet sign-out" onClick={onSignOut}>Sign out</button>
        </div>
      </aside>
    </>
  );
}




