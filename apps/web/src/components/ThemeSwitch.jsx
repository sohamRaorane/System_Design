import { useState } from 'react';
import { THEMES, readTheme, saveTheme } from '../lib/theme.js';

const LABEL = { system: 'Auto', light: 'Light', dark: 'Dark' };

/** Three-way switch: follow the system, or force light or dark. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState(readTheme);
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Colour theme">
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          onClick={() => { saveTheme(t); setTheme(t); }}
        >
          {LABEL[t]}
        </button>
      ))}
    </div>
  );
}
