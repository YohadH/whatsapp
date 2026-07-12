import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import config from '../config/index.js';

// Server-side Supabase client using the service-role key (bypasses RLS — keep
// the key server-only, never expose it to the frontend). Null when Supabase
// Storage isn't configured, in which case uploads fall back to local disk.
//
// The `realtime.transport: ws` option is REQUIRED on Node < 22. supabase-js v2
// constructs a RealtimeClient inside createClient() and throws at boot
// ("Node.js 20 detected without native WebSocket support") unless a WebSocket
// implementation is injected. We only use Storage here, but the crash still
// fires at construction — so the transport must be supplied even though we
// never open a realtime channel. Node 22+ has a native WebSocket global and
// ignores this option, so it is safe to keep regardless of runtime version.
export const supabase = config.supabase.enabled
  ? createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: ws },
    })
  : null;

export default supabase;
