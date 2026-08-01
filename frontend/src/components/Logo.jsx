// HeyIL mark — a chat-bubble "H" robot face in the brand green→cyan→blue gradient.
// Vector so it stays crisp at any size (sidebar, login, favicon). `gid` makes the
// gradient id unique when several logos render on one page.
export default function Logo({ className = 'h-10 w-10', gid = 'heyil' }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} role="img" aria-label="HeyIL">
      <defs>
        <linearGradient id={gid} x1="10" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor="#34d399" />
          <stop offset="0.5" stopColor="#06b6d4" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      {/* accent bubbles (top-left) */}
      <circle cx="15" cy="9" r="4" fill={`url(#${gid})`} />
      <circle cx="8" cy="14" r="2.4" fill={`url(#${gid})`} />
      {/* speech bubble + tail */}
      <rect x="12" y="8" width="46" height="37" rx="11" fill={`url(#${gid})`} />
      <path d="M23 43 L20 55 L34 43 Z" fill={`url(#${gid})`} />
      {/* robot "H" face */}
      <g fill="#ffffff">
        <rect x="23.5" y="16" width="5.5" height="19" rx="2.75" />
        <rect x="41" y="16" width="5.5" height="19" rx="2.75" />
        <rect x="25.5" y="22.75" width="19" height="5.5" rx="2.75" />
        <circle cx="30.5" cy="39.5" r="2.1" />
        <circle cx="39.5" cy="39.5" r="2.1" />
      </g>
    </svg>
  );
}
