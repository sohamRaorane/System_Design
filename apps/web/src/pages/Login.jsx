import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useData } from '../lib/hooks.js';
import { useRouter } from '../lib/router.jsx';
import { Logo } from '../components/Logo.jsx';

export function Login() {
  const { query, navigate } = useRouter();
  const { accept } = useAuth();
  const cfg = useData(() => api.authConfig(), []);
  const [login, setLogin] = useState('');
  const [error, setError] = useState(query.get('error') || '');
  const next = query.get('next') || '/projects';

  const devSignIn = async (e) => {
    e.preventDefault();
    setError('');
    try {
      accept(await api.devLogin(login.trim()));
      navigate(next, { replace: true });
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand" style={{ padding: 0, marginBottom: 28 }}><Logo /> Tracepipe</div>
        <h1>See what every request does across your services</h1>
        <p className="lede">Connect a GitHub repository, send OpenTelemetry traces, and find failed and slow requests without wading through the healthy ones.</p>
        {error ? <div className="notice bad" role="alert" style={{ margin: '0 0 16px' }}>{error}</div> : null}
        {cfg.data?.github !== false ? (
          <a className="btn github" href={api.githubStartUrl(next)} aria-disabled={!cfg.data?.github}>
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.67.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
            Sign in with GitHub
          </a>
        ) : (
          <div className="notice warn">GitHub sign-in is not configured on this collector yet.</div>
        )}
        {cfg.data?.devLogin ? (
          <form onSubmit={devSignIn} className="dev-login">
            <label className="field">Development sign-in (local only)
              <span className="row">
                <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="any-name" aria-label="Development user name" required pattern="[a-zA-Z0-9\-]{1,39}" />
                <button type="submit" className="quiet">Continue</button>
              </span>
            </label>
          </form>
        ) : null}
        <p className="small muted" style={{ marginTop: 22 }}>We ask GitHub only for your public profile. Repository access is granted separately, per repository, when you connect one.</p>
      </div>
    </div>
  );
}
