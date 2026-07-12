export function Spinner({ className = '' }) {
  return (
    <div className={`flex items-center justify-center p-8 ${className}`}>
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-brand-600" />
    </div>
  );
}

export function StatCard({ label, value, sub, accent = 'text-gray-900' }) {
  return (
    <div className="card">
      <div className="text-sm text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${accent}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

const STATUS_STYLES = {
  active: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  abandoned: 'bg-gray-200 text-gray-600',
  needs_human: 'bg-amber-100 text-amber-700',
};
const STATUS_LABELS = {
  active: 'פעילה',
  completed: 'הושלמה',
  abandoned: 'ננטשה',
  needs_human: 'ממתינה לנציג',
};

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_STYLES[status] || 'bg-gray-100 text-gray-600'}`}>{STATUS_LABELS[status] || status}</span>;
}

export function EmptyState({ children }) {
  return <div className="card text-center text-gray-400 py-10">{children}</div>;
}

export function Modal({ open, onClose, title, children, wide }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl shadow-xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h3 className="font-semibold text-lg">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export const INTENT_LABELS = {
  general_question: 'שאלה כללית',
  product_question: 'שאלה על מוצר',
  service_question: 'שאלה על שירות',
  pricing_question: 'שאלת מחיר',
  shipping_question: 'שאלת משלוח',
  booking_request: 'בקשת תור',
  payment_request: 'בקשת תשלום',
  support_request: 'בקשת תמיכה',
  human_agent_request: 'בקשת נציג',
  predefined_flow_start: 'תהליך מוגדר',
  unknown: 'לא ידוע',
};
