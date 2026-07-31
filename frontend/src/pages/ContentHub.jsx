import { useState } from 'react';
import KnowledgeBase from './KnowledgeBase.jsx';
import Links from './Links.jsx';

// Combined "content" page — Knowledge Base + Links under one nav entry, switched by
// tabs. Each tab renders the existing self-contained page component (which keeps its
// own header, data-loading and actions), so no logic is duplicated.
const TABS = [
  { key: 'kb', label: '📚 מאגר ידע' },
  { key: 'links', label: '🔗 קישורים' },
];

export default function ContentHub() {
  const [tab, setTab] = useState('kb');
  return (
    <div>
      <div className="flex gap-2 mb-5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`badge px-4 py-2 text-sm transition ${
              tab === t.key ? 'bg-brand-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'kb' ? <KnowledgeBase /> : <Links />}
    </div>
  );
}
