import axios from 'axios';

// Always use same-origin relative URLs. In production the backend serves the
// built app, so "/api/..." hits the same host. In dev, Vite proxies "/api" and
// "/uploads" to the local backend (see vite.config.js). Only set VITE_API_URL
// if the API genuinely lives on a different origin — do NOT set it to localhost
// for production, or that value gets baked into the build.
const baseURL = import.meta.env.VITE_API_URL ?? '';

const api = axios.create({ baseURL });

// Where a super-admin's "acting as tenant" selection is stored. Tenant admins
// don't use this — their tenant is bound to the token server-side.
export const ACTIVE_TENANT_KEY = 'wa_active_tenant';

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('wa_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const activeTenant = localStorage.getItem(ACTIVE_TENANT_KEY);
  // Platform-admin routes manage tenants themselves — don't scope those.
  if (activeTenant && !String(config.url || '').startsWith('/api/admin')) {
    config.headers['X-Tenant-Id'] = activeTenant;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && !location.pathname.startsWith('/login')) {
      localStorage.removeItem('wa_token');
      location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
