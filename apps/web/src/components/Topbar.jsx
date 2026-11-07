import { useEffect, useState } from 'react';
import { ago } from '../lib/format.js';
import { usePipeline } from '../lib/pipeline.js';
import { Link, useRouter } from '../lib/router.jsx';

const SECTION_LABEL = {
  projects: 'Projects', overview: 'Overview', traces: 'Traces', services: 'Services',
  load: 'Load test', connect: 'Repository', settings: 'Settings', pipeline: 'Pipeline', admin: 'Admin',
};

export function Topbar({ pid, project, section, menuOpen = false, onMenu }) {
  const { navigate } = useRouter();
  const pipeline = usePipeline();
  const [traceId, setTraceId] = useState('');
  const base = pid ? `/p/${pid}` : '';

  useEffect(() => { setTraceId(''); }, [pid]);

  const submit = (e) => {
    e.preventDefault();
    const id = traceId.trim();
    if (id && pid) navigate(`${base}/traces/${encodeURIComponent(id)}`);
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button type="button" className="menu-button quiet" aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="app-navigation" onClick={onMenu}>
          <span aria-hidden="true">☰</span>
        </button>
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <ol>
            <li><Link to="/projects">Projects</Link></li>
            {pid ? (
              <>
                <li aria-hidden="true" className="crumb-sep">/</li>
                <li><Link to={`${base}/overview`}>{project?.name || 'Project'}</Link></li>
              </>
            ) : null}
            <li aria-hidden="true" className="crumb-sep">/</li>
            <li aria-current="page">{SECTION_LABEL[section] || section}</li>
          </ol>
        </nav>
      </div>

      <div className="topbar-actions">
        {pid ? (
          <form className="topbar-search" onSubmit={submit} role="search">
            <input aria-label="Search trace id" placeholder="Search trace id" value={traceId} onChange={(e) => setTraceId(e.target.value)} className="mono" spellCheck="false" />
            <button type="submit" className="quiet" disabled={!traceId.trim()}>Open</button>
          </form>
        ) : null}
        <span className="live-indicator" title="Collector metrics are polled every two seconds">
          <span className={`dot${pipeline.error && !pipeline.data ? ' bad' : pipeline.data ? '' : ' idle'}`} aria-hidden="true" />
          <span>{pipeline.lastUpdated ? `Updated ${ago(pipeline.lastUpdated)}` : 'Connecting'}</span>
        </span>
        <button type="button" className="quiet refresh-button" onClick={() => window.dispatchEvent(new Event('tracepipe:refresh'))} title="Refresh data on this page">
          <span aria-hidden="true">↻</span> Refresh
        </button>
      </div>
    </header>
  );
}
