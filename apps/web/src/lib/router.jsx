// A tiny pushState router: enough for a handful of pages, no dependency.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const RouterCtx = createContext(null);

export function RouterProvider({ children }) {
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, search: window.location.search }));
  useEffect(() => {
    const onPop = () => setLoc({ path: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to, { replace = false } = {}) => {
    const url = new URL(to, window.location.origin);
    if (url.pathname + url.search === window.location.pathname + window.location.search) return;
    window.history[replace ? 'replaceState' : 'pushState']({}, '', url.pathname + url.search);
    setLoc({ path: url.pathname, search: url.search });
    if (!replace) window.scrollTo({ top: 0 });
  }, []);
  const value = useMemo(() => ({ ...loc, query: new URLSearchParams(loc.search), navigate }), [loc, navigate]);
  return <RouterCtx.Provider value={value}>{children}</RouterCtx.Provider>;
}

export const useRouter = () => useContext(RouterCtx);

/** Match "/projects/:id/traces" against a path; returns params or null. */
export function match(pattern, path) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  const m = re.exec(path);
  if (!m) return null;
  return Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
}

export function Link({ to, children, className, activePrefix, ...rest }) {
  const { navigate, path } = useRouter();
  const current = activePrefix ? path === activePrefix || path.startsWith(activePrefix + '/') : path === to;
  return (
    <a
      href={to}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
