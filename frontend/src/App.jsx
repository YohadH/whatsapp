import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';

import Login from './pages/Login.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Conversations from './pages/Conversations.jsx';
import ConversationDetail from './pages/ConversationDetail.jsx';
import Leads from './pages/Leads.jsx';
import Flows from './pages/Flows.jsx';
import ContentHub from './pages/ContentHub.jsx';
import Analytics from './pages/Analytics.jsx';
import Broadcast from './pages/Broadcast.jsx';
import Credits from './pages/Credits.jsx';
import Settings from './pages/Settings.jsx';
import Tenants from './pages/Tenants.jsx';
import Onboarding from './pages/Onboarding.jsx';
import Expenses from './pages/Expenses.jsx';

// Protected route. `tenantScoped` pages need an active tenant: a super-admin who
// hasn't selected a business is sent to /tenants (avoids tenant-less API 400s).
// `bare` renders without the Layout shell (full-screen flows like onboarding).
function Protected({ children, tenantScoped = true, superAdminOnly = false, bare = false }) {
  const { user, loading, isSuperAdmin, activeTenantId } = useAuth();
  if (loading) return <Spinner className="h-screen" />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustResetPassword) return <Navigate to="/reset-password" replace />;
  if (superAdminOnly && !isSuperAdmin) return <Navigate to="/dashboard" replace />;
  if (tenantScoped && isSuperAdmin && !activeTenantId) return <Navigate to="/tenants" replace />;
  if (bare) return children;
  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <Routes>
      {/* '/' is the static marketing landing page (served by the server, not React). */}
      <Route path="/login" element={<Login />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/tenants" element={<Protected tenantScoped={false} superAdminOnly><Tenants /></Protected>} />
      <Route path="/onboarding" element={<Protected bare><Onboarding /></Protected>} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/conversations" element={<Protected><Conversations /></Protected>} />
      <Route path="/conversations/:id" element={<Protected><ConversationDetail /></Protected>} />
      <Route path="/leads" element={<Protected><Leads /></Protected>} />
      <Route path="/flows" element={<Protected><Flows /></Protected>} />
      <Route path="/content" element={<Protected><ContentHub /></Protected>} />
      {/* Old separate routes now redirect into the combined content hub. */}
      <Route path="/knowledge-base" element={<Navigate to="/content" replace />} />
      <Route path="/links" element={<Navigate to="/content" replace />} />
      <Route path="/analytics" element={<Protected><Analytics /></Protected>} />
      <Route path="/broadcast" element={<Protected><Broadcast /></Protected>} />
      <Route path="/expenses" element={<Protected><Expenses /></Protected>} />
      <Route path="/credits" element={<Protected><Credits /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
