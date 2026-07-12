import dotenv from 'dotenv';
dotenv.config();

const token = process.env.WHATSAPP_TOKEN;
const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
const v = process.env.WHATSAPP_API_VERSION || 'v21.0';

if (!token || !id) {
  console.log(`❌ Missing ${!token ? 'WHATSAPP_TOKEN' : ''} ${!id ? 'WHATSAPP_PHONE_NUMBER_ID' : ''}`.trim());
  process.exit(1);
}

const url = `https://graph.facebook.com/${v}/${id}?fields=display_phone_number,verified_name,quality_rating,platform_type,code_verification_status&access_token=${encodeURIComponent(token)}`;
const r = await fetch(url);
const body = await r.json();

if (r.status === 200) {
  console.log('✅ Phone Number ID is valid and linked to your token:');
  console.log(`   number:   ${body.display_phone_number}`);
  console.log(`   name:     ${body.verified_name || '(unverified)'}`);
  console.log(`   quality:  ${body.quality_rating || '-'}`);
  console.log(`   platform: ${body.platform_type || '-'}`);
  console.log(`   verified: ${body.code_verification_status || '-'}`);
} else {
  console.log(`❌ Phone Number ID check failed (${r.status}):`, JSON.stringify(body));
}
