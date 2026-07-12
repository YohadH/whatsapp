import bcrypt from 'bcryptjs';
import prisma from '../src/lib/prisma.js';
import config from '../src/config/index.js';
import { encryptSecret, encryptionConfigured } from '../src/lib/crypto.js';
import { planEntitlements } from '../src/lib/plans.js';

// Seed for a FRESH multi-tenant database:
//  1) a platform super-admin (manages all tenants), and
//  2) one demo tenant with its own admin + sample flows/links/KB.
// Existing single-tenant data is migrated separately by scripts/backfill-tenants.mjs.
async function main() {
  console.log('🌱 Seeding (multi-tenant)…');

  // ── Platform super-admin ───────────────────────────────────
  const superEmail = (process.env.SUPERADMIN_EMAIL || 'owner@example.com').toLowerCase();
  const superPassword = process.env.SUPERADMIN_PASSWORD || 'change-me-now';
  await prisma.adminUser.upsert({
    where: { email: superEmail },
    update: {},
    create: {
      email: superEmail,
      name: 'Platform Owner',
      passwordHash: await bcrypt.hash(superPassword, 10),
      role: 'super_admin',
      tenantId: null,
      mustResetPassword: !process.env.SUPERADMIN_PASSWORD,
    },
  });
  console.log(`   ✓ super-admin: ${superEmail}${process.env.SUPERADMIN_PASSWORD ? '' : ' / change-me-now (reset on first login)'}`);

  // ── Demo tenant ────────────────────────────────────────────
  const ent = planEntitlements('trial');
  const useEnvCreds = config.whatsapp.token && encryptionConfigured();
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      name: 'סטודיו לדוגמה',
      slug: 'demo',
      plan: 'trial',
      dailyBroadcastCap: ent.dailyBroadcastCap,
      monthlyMessageLimit: ent.monthlyMessageLimit,
      bioTitle: 'ישראל בידור',
      bioSubtitle: 'עקבו אחרינו 🎬',
      waPhoneNumberId: useEnvCreds ? config.whatsapp.phoneNumberId || null : null,
      waBusinessAccountId: useEnvCreds ? config.whatsapp.businessAccountId || null : null,
      waTokenEnc: useEnvCreds ? encryptSecret(config.whatsapp.token) : null,
      knowledgeBase: {
        create: {
          businessDescription: 'סטודיו ליופי וטיפוח המציע מגוון טיפולים מקצועיים בעיר תל אביב.',
          serviceInfo: 'טיפולי פנים, איפור, עיצוב גבות, וטיפולי ספא. הטיפולים אורכים בין 45 ל-90 דקות.',
          prices: 'טיפול פנים: 250 ₪. עיצוב גבות: 80 ₪. איפור ערב: 350 ₪.',
          shippingInfo: 'אין משלוחים — שירות במקום בלבד.',
          returnPolicy: 'ביטול עד 24 שעות לפני התור ללא חיוב.',
          faq: 'ש: צריך לקבוע תור מראש? ת: כן, מומלץ לקבוע תור מראש דרך הקישור.\nש: יש חניה? ת: יש חניון ציבורי בסמוך.',
          openingHours: 'ראשון–חמישי 09:00–19:00, שישי 09:00–14:00, שבת סגור.',
          contactDetails: 'טלפון: 03-1234567, מייל: info@example.com',
          limitations: 'איננו מבצעים טיפולים רפואיים. אין מענה מחוץ לשעות הפעילות.',
          customInstructions: 'תמיד הציעו לקבוע תור דרך הקישור כאשר הלקוח מתעניין בטיפול.',
        },
      },
    },
  });
  console.log(`   ✓ demo tenant: ${tenant.slug}`);

  // ── Demo tenant admin ──────────────────────────────────────
  await prisma.adminUser.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      tenantId: tenant.id,
      email: 'admin@example.com',
      name: 'מנהל/ת',
      passwordHash: await bcrypt.hash('admin123', 10),
      role: 'admin',
      mustResetPassword: true,
    },
  });
  console.log('   ✓ tenant admin: admin@example.com / admin123 (reset on first login)');

  // Only seed sample flows/links once (idempotent-ish: skip if the tenant already has flows).
  const hasFlows = await prisma.flow.count({ where: { tenantId: tenant.id } });
  if (!hasFlows) {
    const bookingLink = await prisma.link.create({
      data: { tenantId: tenant.id, name: 'קישור לקביעת תור', url: 'https://example.com/booking', description: 'קביעת תור אונליין', isActive: true, trackClicks: true },
    });
    const catalogLink = await prisma.link.create({
      data: { tenantId: tenant.id, name: 'קטלוג טיפולים', url: 'https://example.com/catalog', description: 'רשימת כל הטיפולים והמחירים', isActive: true, trackClicks: true },
    });

    await prisma.flow.create({
      data: {
        tenantId: tenant.id,
        name: 'קביעת פגישה',
        description: 'איסוף פרטים לקביעת תור לטיפול',
        triggerWords: ['פגישה', 'לקבוע', 'תור', 'שיחה', 'זימון'],
        finalMessage: 'תודה, קיבלתי את הפרטים שלך 🙏 ניצור איתך קשר לאישור התור.',
        linkId: bookingLink.id,
        isActive: true,
        questions: {
          create: [
            { tenantId: tenant.id, questionText: 'מה השם המלא שלך?', questionType: 'text', isRequired: true, orderIndex: 0 },
            { tenantId: tenant.id, questionText: 'מה מספר הטלפון שלך?', questionType: 'phone', isRequired: true, orderIndex: 1 },
            { tenantId: tenant.id, questionText: 'איזה שירות מעניין אותך?', questionType: 'single_choice', options: ['טיפול פנים', 'עיצוב גבות', 'איפור ערב'], isRequired: true, orderIndex: 2 },
            { tenantId: tenant.id, questionText: 'מתי נוח לך להגיע? (יום ושעה מועדפים)', questionType: 'text', isRequired: false, orderIndex: 3 },
          ],
        },
      },
    });

    await prisma.flow.create({
      data: {
        tenantId: tenant.id,
        name: 'בקשת קטלוג',
        description: 'שליחת קטלוג טיפולים ללקוח מתעניין',
        triggerWords: ['קטלוג', 'מחירון', 'רשימה', 'טיפולים'],
        finalMessage: 'הנה הקטלוג שלנו 😊 מוזמן/ת לעיין ולחזור אליי עם כל שאלה.',
        linkId: catalogLink.id,
        isActive: true,
        questions: {
          create: [
            { tenantId: tenant.id, questionText: 'מה השם שלך?', questionType: 'text', isRequired: true, orderIndex: 0 },
            { tenantId: tenant.id, questionText: 'מה הכי מעניין אותך?', questionType: 'single_choice', options: ['טיפולי פנים', 'איפור', 'ספא'], isRequired: false, orderIndex: 1 },
          ],
        },
      },
    });
    console.log('   ✓ demo flows + links');
  }

  console.log('✅ Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
