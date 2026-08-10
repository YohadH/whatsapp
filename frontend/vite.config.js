import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two HTML entries:
//   index.html → the public marketing landing page (crawlable at /)
//   app.html   → the React admin SPA shell (served for every in-app route)
// In production Express serves index.html at / and falls back to app.html for
// other routes (see backend/src/app.js). In dev, Vite's own fallback would serve
// index.html for everything, so this plugin rewrites app-route navigations to
// /app.html — keeping / on the landing and /dashboard, /login, … on the SPA.
function appShellFallback() {
  return {
    name: 'heyil-app-shell-fallback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const wantsHtml = (req.headers.accept || '').includes('text/html');
        const isRoute =
          req.method === 'GET' &&
          wantsHtml &&
          url !== '/' &&
          !url.startsWith('/landing') &&
          !url.startsWith('/@') &&
          !url.startsWith('/src') &&
          !url.startsWith('/node_modules') &&
          !url.startsWith('/api') &&
          !url.startsWith('/uploads') &&
          !/\.[^/]+$/.test(url); // has no file extension → it's a client route
        if (isRoute) req.url = '/app.html';
        next();
      });
    },
  };
}

// Dev-server proxy target for the backend. Configurable so the proxy can point at
// a non-default backend without editing this file (avoids the "proxy points at a
// stale/wrong backend" class of issue). Precedence:
//   VITE_BACKEND_PROXY_TARGET  → full URL, wins if set (e.g. http://localhost:5010)
//   BACKEND_PORT               → port only, target becomes http://localhost:<port>
//   fallback                   → http://localhost:4010 (the historical default)
const backendProxyTarget =
  process.env.VITE_BACKEND_PROXY_TARGET ||
  `http://localhost:${process.env.BACKEND_PORT || '4010'}`;

export default defineConfig({
  plugins: [appShellFallback(), react()],
  build: {
    rollupOptions: {
      // Resolved relative to the project root (this folder).
      input: {
        main: 'index.html',
        app: 'app.html',
      },
    },
  },
  // Dev-only: forward API + uploaded-file requests to the local backend so the
  // frontend can use same-origin relative URLs (matching production).
  server: {
    port: 5173,
    proxy: {
      '/api': backendProxyTarget,
      '/uploads': backendProxyTarget,
    },
  },
});
