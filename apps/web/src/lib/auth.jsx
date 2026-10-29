// Session state for the whole app. On load we try to resume the session from the
// httpOnly cookie; the access token is refreshed a minute before it expires.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, onSessionEnded, refreshSession, setAccessToken } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null });
  const timer = useRef(null);

  const schedule = useCallback((expiresIn) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const s = await refreshSession();
      if (s) { setState({ status: 'signedIn', user: s.user }); schedule(s.expires_in); } else setState({ status: 'signedOut', user: null });
    }, Math.max(10, expiresIn - 60) * 1000);
  }, []);

  const accept = useCallback((session) => {
    setAccessToken(session.access_token);
    setState({ status: 'signedIn', user: session.user });
    schedule(session.expires_in);
  }, [schedule]);

  useEffect(() => {
    onSessionEnded(() => setState({ status: 'signedOut', user: null }));
    refreshSession().then((s) => (s ? accept(s) : setState({ status: 'signedOut', user: null })))
      .catch(() => setState({ status: 'signedOut', user: null }));
    return () => clearTimeout(timer.current);
  }, [accept]);

  const signOut = useCallback(async () => {
    clearTimeout(timer.current);
    try { await api.logout(); } catch { /* already signed out */ }
    setAccessToken(null);
    setState({ status: 'signedOut', user: null });
  }, []);

  return <AuthCtx.Provider value={{ ...state, accept, signOut }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
