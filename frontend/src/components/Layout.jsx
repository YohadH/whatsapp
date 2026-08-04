import { useEffect, useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api/client.js';

const NAV = [
  { to: '/dashboard', label: 'דאשבורד', icon: '📊', end: true },
  { to: '/conversations', label: 'שיחות', icon: '💬' },
  { to: '/leads', label: 'מנהל לידים', icon: '🧲' },
  { to: '/flows', label: 'תהליכים', icon: '🔀' },
  { to: '/content', label: 'מאגר ידע וקישורים', icon: '📚' },
  { to: '/broadcast', label: 'דיוור', icon: '📤' },
  { to: '/expenses', label: 'הוצאות', icon: '🧾' },
  { to: '/analytics', label: 'אנליטיקס', icon: '📈' },
  { to: '/credits', label: 'קרדיטים', icon: '🎟️' },
  { to: '/settings', label: 'הגדרות', icon: '⚙️' },
];

export default function Layout({ children }) {
  const { user, logout, isSuperAdmin, activeTenantId, setActiveTenant } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // On mobile the sidebar is a drawer; close it whenever the route changes.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  // Business name + logo for the mobile top bar (centered). Only fetched when a
  // tenant context exists (a super-admin who hasn't picked a business has none).
  const [biz, setBiz] = useState({ name: '', logoUrl: '' });
  const hasTenant = !isSuperAdmin || !!activeTenantId;
  useEffect(() => {
    if (!hasTenant) { setBiz({ name: '', logoUrl: '' }); return; }
    api.get('/api/settings/profile')
      .then((r) => setBiz({ name: r.data.name || '', logoUrl: r.data.logoUrl || '' }))
      .catch(() => {});
  }, [hasTenant, activeTenantId]);

  // Nav item styling — active gets an on-brand green→blue tinted pill; inactive is muted.
  const navClass = ({ isActive }) =>
    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
      isActive
        ? 'bg-gradient-to-l from-brand-500/25 to-accent-500/25 text-white font-semibold ring-1 ring-white/10'
        : 'text-white/60 hover:bg-white/10 hover:text-white'
    }`;

  return (
    // h-[100dvh] (not 100vh) so iOS Safari's dynamic toolbar doesn't leave a gap.
    <div className="flex h-screen h-[100dvh] overflow-hidden">
      {/* Mobile drawer backdrop */}
      {drawerOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setDrawerOpen(false)} aria-hidden />
      )}
      {/* Sidebar — off-canvas drawer on mobile (slides from the right in RTL), static on desktop */}
      <aside
        className={`fixed lg:static inset-y-0 right-0 z-40 w-64 shrink-0 bg-heyil-dark text-white flex flex-col
          transition-transform duration-200 lg:transition-none lg:translate-x-0
          ${drawerOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}`}
      >
        <div className="px-5 py-5 border-b border-white/10">
          <img src="/brand/logo-transparent-dark.png" alt="HeyIL" className="h-16 w-auto" />
          <div className="text-[11px] text-white/40 mt-2">{isSuperAdmin ? 'קונסולת פלטפורמה' : 'סוכן WhatsApp חכם'}</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {isSuperAdmin && (
            <NavLink to="/tenants" className={navClass}>
              <span className="text-base">🏢</span>עסקים
            </NavLink>
          )}
          {/* Tenant-scoped nav: hidden for a super-admin who hasn't picked a business yet. */}
          {(!isSuperAdmin || activeTenantId) && NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
              <span className="text-base">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-2.5 px-1 mb-2">
            <div className="h-8 w-8 rounded-full bg-white/10 grid place-items-center text-sm font-semibold text-white/80">
              {(user?.name || '?').trim().charAt(0)}
            </div>
            <div className="min-w-0">
              <div className="text-sm truncate">{user?.name}</div>
              <div className="text-[11px] text-white/40 truncate">{user?.email}</div>
            </div>
          </div>
          <button onClick={() => { logout(); navigate('/login'); }} className="w-full text-right text-sm text-white/60 hover:text-white px-2 py-1.5 rounded-lg hover:bg-white/10 transition">
            התנתקות ←
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
        {/* Mobile top bar — hamburger (start/right in RTL) · business name (center) ·
            HeyIL mark (end/left). Safe-area top padding clears the iPhone notch. */}
        <div
          className="lg:hidden sticky top-0 z-20 flex items-center gap-3 bg-heyil-dark text-white px-4 py-3 shadow-md"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <button onClick={() => setDrawerOpen(true)} className="p-2 -mr-2 shrink-0 rounded-lg hover:bg-white/10 transition" aria-label="תפריט">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex-1 min-w-0 text-center font-semibold truncate px-1">
            {biz.name || (isSuperAdmin ? 'קונסולת פלטפורמה' : '')}
          </div>
          {biz.logoUrl ? (
            <img src={biz.logoUrl} alt={biz.name} className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-white/20" />
          ) : (
            <img src="/brand/logo-mark-512.png" alt="HeyIL" className="h-9 w-9 shrink-0 rounded-lg ring-1 ring-white/15" />
          )}
        </div>

        {/* Super-admin "acting as tenant" banner. */}
        {isSuperAdmin && activeTenantId && (
          <div className="bg-amber-100 text-amber-900 text-sm px-4 py-2 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate">👀 צפייה כעסק נבחר — הנתונים הם של אותו עסק בלבד.</span>
            <button className="underline shrink-0" onClick={() => { setActiveTenant(null); navigate('/tenants'); }}>
              חזרה לרשימת העסקים
            </button>
          </div>
        )}
        <div className="max-w-7xl mx-auto p-4 sm:p-6">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  // Stack on mobile so the title/subtitle get the FULL width (actions drop below),
  // instead of the title being squeezed next to the action buttons.
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between mb-6 gap-3 sm:gap-4">
      <div className="min-w-0 w-full">
        <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
