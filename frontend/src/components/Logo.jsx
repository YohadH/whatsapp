// HeyIL wordmark — real HTML text so it always renders with the loaded font.
// "Hey" inherits currentColor (white on the dark shell, Ink on light), "IL" in
// Signal blue, with the blue→pink signature swoosh under "Hey". Size it by passing
// a text-size class (e.g. text-2xl) plus a color class. `dir="ltr"` keeps Latin
// order correct inside the RTL app.
export default function Logo({ className = 'text-2xl', gid = 'heyil' }) {
  return (
    <span
      dir="ltr"
      aria-label="HeyIL"
      className={`relative inline-flex items-end font-extrabold leading-none tracking-tight ${className}`}
    >
      <span className="relative">
        Hey
        <svg
          className="absolute pointer-events-none"
          style={{ left: '-4%', bottom: '-0.16em', width: '112%', height: '0.42em', overflow: 'visible' }}
          viewBox="0 0 100 14"
          preserveAspectRatio="none"
          fill="none"
        >
          <defs>
            <linearGradient id={`sw-${gid}`} x1="0" y1="13" x2="100" y2="1" gradientUnits="userSpaceOnUse">
              <stop stopColor="#1A69F5" />
              <stop offset="0.55" stopColor="#7B5CF0" />
              <stop offset="1" stopColor="#F7A8C8" />
            </linearGradient>
          </defs>
          <path d="M2 8C28 15 62 13 90 4c4-1.3 7-3 8-3.5" stroke={`url(#sw-${gid})`} strokeWidth="3" strokeLinecap="round" />
        </svg>
      </span>
      <span className="text-brand-500 font-bold ms-[0.12em]" style={{ fontSize: '0.52em' }}>IL</span>
    </span>
  );
}
