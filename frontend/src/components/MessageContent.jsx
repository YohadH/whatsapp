import { useEffect, useState } from 'react';
import api from '../api/client.js';

// Renders the body of a single chat message bubble — the ACTUAL media (image /
// audio / video inline, documents as a download) for inbound WhatsApp media
// messages, or plain text for everything else.
//
// Bytes come from the authenticated media proxy (GET /api/conversations/media/
// :messageId — backend routes/conversations.js), which downloads via the Graph
// API with the tenant token and caches to disk. A bare <img src> can't carry the
// Authorization header, so media is fetched as a blob through the api client and
// rendered from an object URL. While loading — and whenever the proxy fails
// (simulator mode, expired media) — the typed MediaCard below stays the fallback.

// Hebrew label per media kind (mirrors backend MEDIA_KIND_LABEL).
const KIND_LABEL = {
  image: 'תמונה',
  video: 'סרטון',
  audio: 'הודעה קולית',
  voice: 'הודעה קולית',
  document: 'מסמך',
  sticker: 'מדבקה',
  location: 'מיקום',
  contacts: 'איש קשר',
};

// Derive a structured media descriptor from a persisted message's rawPayload.
// Returns null for plain text / non-media messages.
export function mediaFromMessage(m) {
  const raw = m?.rawPayload;
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.type;
  if (!kind || kind === 'text' || kind === 'button' || kind === 'interactive') return null;
  const sub = raw[kind] || {};
  const caption =
    typeof sub.caption === 'string' && sub.caption.trim() ? sub.caption.trim() : null;
  const filename =
    typeof sub.filename === 'string' && sub.filename.trim() ? sub.filename.trim() : null;
  let locationName = null;
  if (kind === 'location') locationName = raw.location?.name || raw.location?.address || null;
  return {
    kind,
    label: KIND_LABEL[kind] || kind,
    caption,
    filename,
    mimeType: sub.mime_type || null,
    mediaId: sub.id || null,
    locationName,
  };
}

function MediaIcon({ kind }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (kind) {
    case 'image':
    case 'sticker':
      return (<svg {...common}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>);
    case 'video':
      return (<svg {...common}><rect x="2" y="5" width="15" height="14" rx="2" /><path d="m22 8-5 4 5 4V8z" /></svg>);
    case 'audio':
    case 'voice':
      return (<svg {...common}><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" /></svg>);
    case 'document':
      return (<svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h4" /></svg>);
    case 'location':
      return (<svg {...common}><path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg>);
    case 'contacts':
      return (<svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /></svg>);
    default:
      return (<svg {...common}><path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>);
  }
}

// A compact media card shown in place of the literal "[image]" placeholder.
function MediaCard({ media }) {
  const { kind, label, caption, filename, locationName } = media;
  // Primary line under the icon: filename for docs, location name, else the type label.
  const primary = filename || (kind === 'location' && locationName ? `${label} · ${locationName}` : label);
  return (
    <div>
      <div className="flex items-center gap-2 rounded-lg bg-black/5 px-2.5 py-2">
        <span className="shrink-0 grid place-items-center h-8 w-8 rounded-md bg-black/10 text-slate-700">
          <MediaIcon kind={kind} />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-slate-800 truncate">{primary}</span>
          <span className="block text-[11px] text-slate-500">{label}</span>
        </span>
      </div>
      {caption && <div className="mt-1 whitespace-pre-wrap">{caption}</div>}
    </div>
  );
}

// Fetch a message's media bytes through the authenticated proxy → object URL.
// (A plain <img src> can't send the Bearer token.) Cleans up the URL on unmount.
function useMediaBlob(messageId, enabled) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || !messageId) return undefined;
    let alive = true;
    let obj = null;
    api
      .get(`/api/conversations/media/${messageId}`, { responseType: 'blob' })
      .then((r) => {
        if (!alive) return;
        obj = URL.createObjectURL(r.data);
        setUrl(obj);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => {
      alive = false;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [messageId, enabled]);
  return { url, failed };
}

// Kinds the proxy can render inline; everything else keeps the typed card.
const RENDERABLE = new Set(['image', 'sticker', 'video', 'audio', 'voice', 'document']);

function MediaView({ media, message }) {
  const { kind, caption, filename } = media;
  const { url, failed } = useMediaBlob(message.id, RENDERABLE.has(kind));

  // Loading or proxy failure (simulator mode / expired media) → typed card.
  if (!url || failed) return <MediaCard media={media} />;

  let body = null;
  if (kind === 'image' || kind === 'sticker') {
    body = (
      <a href={url} target="_blank" rel="noopener noreferrer" title="פתיחה בגודל מלא">
        <img src={url} alt={caption || 'תמונה'} className="max-h-64 max-w-full rounded-lg object-contain" />
      </a>
    );
  } else if (kind === 'video') {
    body = <video src={url} controls className="max-h-64 max-w-full rounded-lg" />;
  } else if (kind === 'audio' || kind === 'voice') {
    body = <audio src={url} controls className="max-w-full" />;
  } else if (kind === 'document') {
    body = (
      <a href={url} download={filename || 'document'} className="flex items-center gap-2 rounded-lg bg-black/5 px-2.5 py-2 hover:bg-black/10 transition">
        <span className="shrink-0 grid place-items-center h-8 w-8 rounded-md bg-black/10 text-slate-700"><MediaIcon kind="document" /></span>
        <span className="text-[13px] font-medium text-slate-800 truncate">{filename || 'הורדת מסמך'}</span>
      </a>
    );
  }
  return (
    <div>
      {body}
      {caption && <div className="mt-1 whitespace-pre-wrap">{caption}</div>}
    </div>
  );
}

// Body renderer for a message bubble. Renders the real media (with a typed-card
// fallback) for inbound media messages, otherwise the plain messageText.
export default function MessageContent({ message }) {
  const media = mediaFromMessage(message);
  if (media) return <MediaView media={media} message={message} />;
  return <span>{message.messageText}</span>;
}
