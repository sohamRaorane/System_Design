// Theme preference: 'system' (follow the OS), 'light' or 'dark'. Stored per browser; storage
// can be unavailable (private windows, blocked site data), so every access is guarded.
const KEY = 'tracepipe.theme';
export const THEMES = ['system', 'light', 'dark'];

export function readTheme() {
  try {
    const v = window.localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

export function saveTheme(theme) {
  applyTheme(theme);
  try { window.localStorage.setItem(KEY, theme); } catch { /* not persisted; still applied */ }
}
