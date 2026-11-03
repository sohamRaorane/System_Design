import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from './lib/router.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { App } from './App.jsx';
import { applyTheme, readTheme } from './lib/theme.js';
import './styles.css';

// Apply the saved theme before the first paint so the page never flashes the wrong one.
applyTheme(readTheme());

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RouterProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </RouterProvider>
  </StrictMode>,
);
