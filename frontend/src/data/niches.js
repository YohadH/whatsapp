// Niche list for the signup picker. IDs must match backend src/data/nichePacks.js —
// the chosen id is sent to /api/auth/register, which seeds the matching starter pack.
export const NICHES = [
  { id: 'lawyer', label: 'עורכי דין', emoji: '⚖️', tagline: 'ייעוץ ותיאום פגישות' },
  { id: 'clinic', label: 'קליניקות ומרפאות', emoji: '🩺', tagline: 'קביעת תורים ותזכורות' },
  { id: 'online_store', label: 'חנות אונליין', emoji: '🛒', tagline: 'הזמנות ומעקב משלוחים' },
  { id: 'physical_store', label: 'חנות פיזית', emoji: '🏬', tagline: 'מלאי ושריון פריטים' },
  { id: 'support', label: 'שירות לקוחות', emoji: '🎧', tagline: 'פניות ומעבר ל-CRM' },
  { id: 'restaurant', label: 'מסעדות', emoji: '🍽️', tagline: 'הזמנת מקום ותפריט' },
  { id: 'real_estate', label: 'נדל״ן', emoji: '🏠', tagline: 'לידים ותיאום סיורים' },
  { id: 'beauty', label: 'יופי ומספרות', emoji: '💇', tagline: 'תורים ומחירון' },
  { id: 'fitness', label: 'כושר וסטודיו', emoji: '🏋️', tagline: 'שיעורים ואימוני ניסיון' },
  { id: 'trades', label: 'בעלי מקצוע', emoji: '🛠️', tagline: 'הצעות מחיר וביקורי בית' },
  { id: 'other', label: 'אחר', emoji: '💬', tagline: 'התחלה גנרית' },
];
