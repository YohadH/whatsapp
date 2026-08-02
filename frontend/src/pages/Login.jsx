import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Logo from '../components/Logo.jsx';

export default function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Already authenticated: redirect declaratively (render-safe) instead of
  // calling navigate() during render, which triggers React's "Cannot update a
  // component while rendering a different component" warning. Matches the
  // <Navigate> pattern used in App.jsx's Protected route.
  if (user) {
    return <Navigate to={user.role === 'super_admin' ? '/tenants' : '/dashboard'} replace />;
  }

  // Route by account state: temp password → reset; platform owner → tenants.
  function destinationFor(u) {
    if (u.mustResetPassword) return '/reset-password';
    if (u.role === 'super_admin') return '/tenants';
    return '/dashboard';
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const u = await login(email, password);
      navigate(destinationFor(u));
    } catch (err) {
      setError(err.response?.data?.error || 'התחברות נכשלה');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-heyil-dark p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
        <div className="text-center mb-7">
          <div className="flex justify-center mb-3">
            <Logo className="text-4xl text-ink-900" gid="login" />
          </div>
          <p className="text-sm text-slate-500 mt-1">כניסת מנהל/ת</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">אימייל</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label">סיסמה</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-2">{error}</div>}
          <button className="btn-primary w-full" disabled={loading}>
            {loading ? 'מתחבר…' : 'התחברות'}
          </button>
        </form>
      </div>
    </div>
  );
}
