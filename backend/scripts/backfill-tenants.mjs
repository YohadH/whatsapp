// One-time migration: fold an existing SINGLE-tenant database into the
// multi-tenant schema by creating a "default" tenant (from the env WhatsApp
// creds) and assigning every existing row to it.
//
// PREREQUISITE: the multi-tenant schema must already be applied with the new
// tenantId columns present but NULLABLE (so existing rows survive the ALTER).
// Recommended order for a real migration:
//   1. Add the Tenant table + nullable tenantId columns (SQL migration).
//   2. node scripts/backfill-tenants.mjs   ← this script
//   3. Set the tenantId columns NOT NULL + add the unique/index constraints.
//
// Safe to re-run: it upserts the default tenant and only fills rows where
// tenantId IS NULL.
import prisma from '../src/lib/prisma.js';
import config from '../src/config/index.js';
import { encryptSecret, encryptionConfigured } from '../src/lib/crypto.js';

// Tables that gained a tenantId column, and whether they existed before.
const TABLES = [
  'AdminUser',
  'Customer',
  'Conversation',
  'Message',
  'Flow',
  'FlowQuestion',
  'CustomerAnswer',
  'Link',
  'AnalyticsEvent',
  'SuppressedNumber',
  'BroadcastJob',
  'OutboundSend',
  'KnowledgeBase',
];

async function main() {
  console.log('🔧 Backfilling existing rows into a default tenant…');

  const useEnvCreds = config.whatsapp.token && encryptionConfigured();
  if (config.whatsapp.token && !encryptionConfigured()) {
    console.warn('   ⚠ CREDENTIALS_ENC_KEY not set — the default tenant will have NO WhatsApp token stored.');
  }

  // 1) Create (or reuse) the default tenant.
  let tenant = await prisma.tenant.findUnique({ where: { slug: 'default' } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name: process.env.DEFAULT_TENANT_NAME || 'ישראל שידוך',
        slug: 'default',
        status: 'active',
        plan: 'pro',
        dailyBroadcastCap: parseInt(process.env.BROADCAST_DEFAULT_DAILY_CAP || '1800', 10),
        monthlyMessageLimit: 100000,
        bioTitle: config.bio.title,
        bioSubtitle: config.bio.subtitle,
        waPhoneNumberId: config.whatsapp.phoneNumberId || null,
        waBusinessAccountId: config.whatsapp.businessAccountId || null,
        waTokenEnc: useEnvCreds ? encryptSecret(config.whatsapp.token) : null,
        waVerifyToken: config.whatsapp.verifyToken || null,
        legalCompanyName: config.legal.companyName,
        legalContactEmail: config.legal.contactEmail,
        legalWebsiteUrl: config.legal.websiteUrl || null,
      },
    });
    console.log(`   ✓ created default tenant ${tenant.id} (slug: default)`);
  } else {
    console.log(`   • reusing default tenant ${tenant.id}`);
  }

  // 2) Assign every NULL-tenant row to it, table by table, via raw SQL (the
  //    Prisma client can't write a column it now treats as required).
  //
  //    Silent-success guard: an UPDATE that ERRORS (missing table/column, perms)
  //    must NOT be swallowed with a green "complete" at the end — otherwise the
  //    operator proceeds to the irreversible finalize step believing every row
  //    is backfilled when it is not. We (a) record every per-table error, and
  //    (b) immediately RE-READ the remaining NULL count for the same table, so a
  //    write that "succeeded" but changed nothing (0 rows, yet NULLs remain) is
  //    surfaced instead of masked. Any failure or residual NULL → non-zero exit.
  const failures = [];
  const residualNulls = [];
  for (const table of TABLES) {
    // AdminUser.tenantId is nullable by design (super_admin = null); assigning it
    // to the default tenant is fine, but residual NULLs there are NOT an error.
    const nullableByDesign = table === 'AdminUser';
    try {
      const affected = await prisma.$executeRawUnsafe(
        `UPDATE "${table}" SET "tenantId" = $1 WHERE "tenantId" IS NULL`,
        tenant.id
      );
      // Verify the write actually landed: re-read remaining NULLs post-UPDATE.
      const check = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "tenantId" IS NULL`
      );
      const remaining = check?.[0]?.n ?? 0;
      if (remaining > 0 && !nullableByDesign) {
        residualNulls.push(`${table} (${remaining})`);
        console.error(`   ✗ ${table}: ${affected} row(s) updated but ${remaining} still NULL after write`);
      } else {
        console.log(`   ✓ ${table}: ${affected} row(s) assigned (${remaining} NULL remaining)`);
      }
    } catch (err) {
      failures.push(`${table}: ${err.message}`);
      console.error(`   ✗ ${table}: ${err.message}`);
    }
  }

  // 3) Make sure the default tenant owns exactly one KnowledgeBase row.
  const kbCount = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "KnowledgeBase" WHERE "tenantId" = $1`,
    tenant.id
  );
  if ((kbCount?.[0]?.n ?? 0) === 0) {
    // Silent-success guard (same class as the loop above): do NOT swallow the
    // create error and print "✓ created" unconditionally — a failed create would
    // leave the tenant with zero KnowledgeBase rows (/api/knowledge-base 404s
    // post-migration) while the script still reported success. Route any failure
    // into `failures` so the exit-gate below catches it.
    try {
      await prisma.knowledgeBase.create({ data: { tenantId: tenant.id } });
      console.log('   ✓ created empty KnowledgeBase for default tenant');
    } catch (err) {
      failures.push(`KnowledgeBase (create): ${err.message}`);
      console.error(`   ✗ KnowledgeBase create failed: ${err.message}`);
    }
  }

  // Silent-success guard: if ANY table's UPDATE errored, or any gated table
  // still has NULLs after the write, FAIL loudly with a non-zero exit. The
  // runbook's step 2.5 gate must never be reached on a false "complete".
  if (failures.length > 0 || residualNulls.length > 0) {
    if (failures.length > 0) {
      console.error(`\n❌ Backfill had ${failures.length} table error(s):`);
      failures.forEach((f) => console.error(`   - ${f}`));
    }
    if (residualNulls.length > 0) {
      console.error(`\n❌ Tables still holding NULL tenantId after backfill: ${residualNulls.join(', ')}.`);
    }
    console.error('\n   Backfill did NOT fully succeed — do NOT proceed to step 2.5/3. Investigate above.');
    process.exit(1);
  }

  console.log('✅ Backfill complete. Now set the tenantId columns NOT NULL and add constraints.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
