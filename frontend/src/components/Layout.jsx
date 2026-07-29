import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const NAV = [
  { to: '/', label: 'דאשבורד', icon: '📊', end: true },
  { to: '/conversations', label: 'שיחות', icon: '💬' },
  { to: '/leads', label: 'צינור לידים', icon: '🧲' },
  { to: '/flows', label: 'תהליכים', icon: '🔀' },
  { to: '/knowledge-base', label: 'מאגר ידע', icon: '📚' },
  { to: '/links', label: 'קישורים', icon: '🔗' },
  { to: '/broadcast', label: 'שליחה מרובה', icon: '📤' },
  { to: '/analytics', label: 'אנליטיקס', icon: '📈' },
  { to: '/credits', label: 'קרדיטים', icon: '🎟️' },
  { to: '/settings', label: 'הגדרות', icon: '⚙️' },
];

export default function Layout({ children }) {
  const { user, logout, isSuperAdmin, activeTenantId, setActiveTenant } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-60 shrink-0 bg-brand-900 text-white flex flex-col">
        <div className="px-5 py-5 border-b border-white/10">
          <div className="text-lg font-bold flex items-center gap-2">💬 WhatsApp AI</div>
          <div className="text-xs text-white/50 mt-0.5">{isSuperAdmin ? 'קונסולת פלטפורמה' : 'סוכן עסקי חכם'}</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {isSuperAdmin && (
            <NavLink
              to="/tenants"
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  isActive ? 'bg-white/15 font-medium' : 'text-white/70 hover:bg-white/10'
                }`
              }
            >
              <span>🏢</span>עסקים
            </NavLink>
          )}
          {/* Tenant-scoped nav: hidden for a super-admin who hasn't picked a business yet. */}
          {(!isSuperAdmin || activeTenantId) && NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  isActive ? 'bg-white/15 font-medium' : 'text-white/70 hover:bg-white/10'
                }`
              }
            >
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3">
          <div className="text-sm px-2">{user?.name}</div>
          <div className="text-xs text-white/50 px-2 mb-2">{user?.email}</div>
          <button onClick={() => { logout(); navigate('/login'); }} className="w-full text-right text-sm text-white/70 hover:text-white px-2 py-1">
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
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}
