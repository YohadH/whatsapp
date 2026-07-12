import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

// Shown after first login when the account still has a temporary password
// (mustResetPassword). Forces a new password before anything else is usable.
export default function ResetPassword() {
  const { user, changePassword, isSuperAdmin } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!user) {
    navigate('/login');
    return null;
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (next.length < 8) return setError('הסיסמה החדשה חייבת להכיל לפחות 8 תווים');
    if (next !== confirm) return setError('הסיסמאות אינן תואמות');
    setLoading(true);
    try {
      await changePassword(current, next);
      navigate(isSuperAdmin ? '/tenants' : '/');
    } catch (err) {
      setError(err.response?.data?.error || 'שינוי הסיסמה נכשל');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-900 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="text-center mb-6">
          <div className="text-4xl mb-2">🔐</div>
          <h1 className="text-2xl font-bold">בחירת סיסמה חדשה</h1>
          <p className="text-sm text-gray-500 mt-1">נכנסת עם סיסמה זמנית — יש להחליף אותה כדי להמשיך</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">סיסמה נוכחית (זמנית)</label>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </div>
          <div>
            <label className="label">סיסמה חדשה</label>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} required />
          </div>
          <div>
            <label className="label">אימות סיסמה חדשה</label>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-2">{error}</div>}
          <button className="btn-primary w-full" disabled={loading}>
            {loading ? 'שומר…' : 'שמירת סיסמה'}
          </button>
        </form>
      </div>
    </div>
  );
}
