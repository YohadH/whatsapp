import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const NAV = [
  { to: '/', label: 'דאשבורד', icon: '📊', end: true },
  { to: '/conversations', label: 'שיחות', icon: '💬' },
  { to: '/leads', label: 'צינור לידים', icon: '🧲' },
  { to: '/flows', label: 'תהליכים', icon: '🔀' },
  { to: '/content', label: 'מאגר ידע וקישורים', icon: '📚' },
  { to: '/broadcast', label: 'שליחה מרובה', icon: '📤' },
  { to: '/analytics', label: 'אנליטיקס', icon: '📈' },
  { to: '/credits', label: 'קרדיטים', icon: '🎟️' },
  { to: '/settings', label: 'הגדרות', icon: '⚙️' },
];

export default function Layout({ children }) {
  const { user, logout, isSuperAdmin, activeTenantId, setActiveTenant } = useAuth();
  const navigate = useNavigate();

  // Nav item styling — active gets an on-brand green→blue tinted pill; inactive is muted.
  const navClass = ({ isActive }) =>
    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
      isActive
        ? 'bg-gradient-to-l from-brand-500/25 to-accent-500/25 text-white font-semibold ring-1 ring-white/10'
        : 'text-white/60 hover:bg-white/10 hover:text-white'
    }`;

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-64 shrink-0 bg-heyil-dark text-white flex flex-col">
        <div className="px-5 py-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-heyil grid place-items-center text-white font-black text-lg shadow-lg shadow-brand-500/20">
              H
            </div>
            <div>
              <div className="text-2xl font-extrabold leading-none tracking-tight text-heyil">HeyIL</div>
              <div className="text-[11px] text-white/40 mt-1">{isSuperAdmin ? 'קונסולת פלטפורמה' : 'סוכן WhatsApp חכם'}</div>
            </div>
          </div>
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

      <main className="flex-1 overflow-y-auto">
        {/* Super-admin "acting as tenant" banner. */}
        {isSuperAdmin && activeTenantId && (
          <div className="bg-amber-100 text-amber-900 text-sm px-4 py-2 flex items-center justify-between">
            <span>👀 צפייה כעסק נבחר — הנתונים הם של אותו עסק בלבד.</span>
            <button className="underline" onClick={() => { setActiveTenant(null); navigate('/tenants'); }}>
              חזרה לרשימת העסקים
            </button>
          </div>
        )}
        <div className="max-w-7xl mx-auto p-6">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex items-start justify-between mb-6 gap-4">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
