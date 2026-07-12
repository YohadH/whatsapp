import dotenv from 'dotenv';
dotenv.config();

const token = process.env.WHATSAPP_TOKEN;
const v = process.env.WHATSAPP_API_VERSION || 'v21.0';
const base = `https://graph.facebook.com/${v}`;

if (!token) {
  console.log('❌ No WHATSAPP_TOKEN in .env');
  process.exit(1);
}

const g = async (path) => {
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url);
  let body;
  try { body = await r.json(); } catch { body = await r.text(); }
  return { status: r.status, body };
};

// 1) Validate token identity
const me = await g('/me');
if (me.status === 200) console.log('✅ Token valid. /me →', JSON.stringify(me.body));
else { console.log('❌ Token rejected. /me →', me.status, JSON.stringify(me.body)); process.exit(0); }

// 2) Token metadata (scopes / expiry) — best effort
const dbg = await g(`/debug_token?input_token=${encodeURIComponent(token)}`);
if (dbg.status === 200 && dbg.body?.data) {
  const d = dbg.body.data;
  const exp = d.expires_at ? new Date(d.expires_at * 1000).toISOString() : (d.data_access_expires_at ? 'data-access ' + new Date(d.data_access_expires_at * 1000).toISOString() : 'n/a');
  console.log(`ℹ️  type=${d.type} valid=${d.is_valid} expires=${exp}`);
  console.log(`ℹ️  scopes=${(d.scopes || []).join(', ') || 'n/a'}`);
} else {
  console.log('ℹ️  debug_token unavailable:', dbg.status, JSON.stringify(dbg.body).slice(0, 200));
}

// 3) Try to discover Phone Number ID via WABA chain
console.log('\n🔎 Searching for your WhatsApp phone number(s)…');
const found = [];
const biz = await g('/me/businesses?fields=id,name');
if (biz.status === 200 && biz.body?.data?.length) {
  for (const b of biz.body.data) {
    const wabas = await g(`/${b.id}/owned_whatsapp_business_accounts?fields=id,name`);
    for (const w of wabas.body?.data || []) {
      const phones = await g(`/${w.id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`);
      for (const p of phones.body?.data || []) {
        found.push({ business: b.name, waba: w.id, ...p });
      }
    }
  }
} else {
  console.log('   (could not list businesses:', biz.status, JSON.stringify(biz.body).slice(0, 200) + ')');
}

if (found.length) {
  console.log('\n📱 Phone numbers found:');
  for (const p of found) {
    console.log(`   • ${p.display_phone_number}  (${p.verified_name || 'unverified'})  quality=${p.quality_rating || '-'}`);
    console.log(`     WHATSAPP_PHONE_NUMBER_ID=${p.id}`);
  }
} else {
  console.log('\n⚠️  No phone numbers auto-discovered. Grab the "Phone number ID" from');
  console.log('    Meta dashboard → WhatsApp → API Setup, and put it in WHATSAPP_PHONE_NUMBER_ID.');
}
