import { createContext, useContext, useEffect, useState } from 'react';
import api, { ACTIVE_TENANT_KEY } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Super-admin only: which tenant they're currently "acting as".
  const [activeTenantId, setActiveTenantId] = useState(
    () => localStorage.getItem(ACTIVE_TENANT_KEY) || null
  );

  useEffect(() => {
    const token = localStorage.getItem('wa_token');
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .get('/api/auth/me')
      .then((res) => setUser(res.data))
      .catch(() => localStorage.removeItem('wa_token'))
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password) {
    const res = await api.post('/api/auth/login', { email, password });
    localStorage.setItem('wa_token', res.data.token);
    setUser(res.data.user);
    return res.data.user;
  }

  function logout() {
    localStorage.removeItem('wa_token');
    localStorage.removeItem(ACTIVE_TENANT_KEY);
    setUser(null);
    setActiveTenantId(null);
    location.href = '/login';
  }

  async function changePassword(currentPassword, newPassword) {
    await api.post('/api/auth/change-password', { currentPassword, newPassword });
    setUser((u) => (u ? { ...u, mustResetPassword: false } : u));
  }

  // Super-admin: choose which tenant's dashboards to view (sent as X-Tenant-Id).
  function setActiveTenant(tenantId) {
    if (tenantId) localStorage.setItem(ACTIVE_TENANT_KEY, tenantId);
    else localStorage.removeItem(ACTIVE_TENANT_KEY);
    setActiveTenantId(tenantId || null);
  }

  const isSuperAdmin = user?.role === 'super_admin';

  return (
    <AuthContext.Provider
      value={{ user, loading, login, logout, changePassword, isSuperAdmin, activeTenantId, setActiveTenant }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
