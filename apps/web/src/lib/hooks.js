import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Load data and optionally keep refreshing it. Polling pauses while the tab is hidden.
 * Returns { data, error, loading, refresh }.
 */
export function useData(load, deps = [], { every } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      const data = await loadRef.current();
      setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (error.name === 'AbortError') return;
      setState((s) => ({ data: s.data, error, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    refresh();
    if (!every) return () => { alive = false; };
    const id = setInterval(() => {
      if (alive && document.visibilityState === 'visible') refresh();
    }, every);
    return () => { alive = false; clearInterval(id); };
  }, [refresh, every]);

  return { ...state, refresh };
}

/** Remember the previous value of something (to compute "since last refresh" deltas). */
export function usePrevious(value) {
  const ref = useRef();
  useEffect(() => { ref.current = value; }, [value]);
  return ref.current;
}
