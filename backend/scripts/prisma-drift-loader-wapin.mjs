// ESM loader hook for sim-admin-wapin-degrade.mjs.
//
// Emulates the EXACT live-DB state today for the PUT /api/admin/tenants/:id
// finalize block in routes/admin.js: a DB that is one migration BEHIND
// schema.prisma, where `Tenant.waPin` (migration 3_tenant_wa_pin) does NOT yet
// exist physically. Semantics:
//   • tenant.update({ ..., select: <explicit, no waPin> })  → SUCCEEDS
//       (this is the primary write at admin.js:287 — it must commit)
//   • tenant.findUnique({ where:{id} })  (SELECT *, no select) → throws P2022
//       (this is the waPin re-fetch at admin.js:309 — it must throw, exactly as
//        a real one-migration-behind live DB would, because SELECT * asks for the
//        phantom waPin column)
//   • tenant.findUnique/findFirst with an explicit select that omits waPin → OK
//
// Replaces `../lib/prisma.js` for every module that imports it (the real admin
// router included), so the REAL handler runs against simulated drift with NO
// live DB. Registered via register-drift-loader-wapin.mjs.

const PHANTOM_COLUMN = 'waPin';

// A realistic tenant row as the live DB holds it — note: NO waPin column.
const LIVE_ROW = {
  id: 'tnt_demo',
  name: 'Demo Tenant',
  slug: 'demo',
  status: 'active',
  waPhoneNumberId: '15550001111',
  waBusinessAccountId: 'waba_1',
  waVerifyToken: 'vt_1',
  waApiVersion: 'v21.0',
  waTokenEnc: null,
  displayName: 'Demo',
  bioTitle: 'Demo Bio',
  bioSubtitle: 'sub',
  locale: 'he',
  currency: 'ILS',
  timezone: 'Asia/Jerusalem',
  legalCompanyName: null,
  legalContactEmail: null,
  legalWebsiteUrl: null,
  plan: 'starter',
  dailyBroadcastCap: 250,
  monthlyMessageLimit: 1000,
  messagesThisPeriod: 0,
  creditsUsedThisPeriod: 0,
  purchasedCredits: 0,
  periodStartedAt: new Date().toISOString(),
  trialEndsAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const STUB_SOURCE = `
const PHANTOM_COLUMN = ${JSON.stringify(PHANTOM_COLUMN)};
const LIVE_ROW = ${JSON.stringify(LIVE_ROW)};
function p2022() {
  const err = new Error('Invalid \\\`prisma.tenant.findUnique()\\\`: The column \\\`Tenant.' + PHANTOM_COLUMN + '\\\` does not exist in the current database.');
  err.code = 'P2022';
  err.meta = { column: 'Tenant.' + PHANTOM_COLUMN };
  return err;
}
// A read with no \`select\` => SELECT * => asks for the phantom waPin column => P2022.
// A read whose explicit \`select\` lists waPin also throws. An explicit select that
// omits waPin returns only the projected columns (mirrors real Prisma + drift).
function projectOrThrow(args = {}) {
  const select = args && args.select;
  if (!select) throw p2022();
  if (select[PHANTOM_COLUMN]) throw p2022();
  // Merge any \`data\` (an update payload) over the row so the projection reflects
  // the write — exactly as Prisma returns the post-update row.
  const source = args && args.data ? { ...LIVE_ROW, ...args.data } : LIVE_ROW;
  const out = {};
  for (const k of Object.keys(select)) if (select[k]) out[k] = source[k];
  return out;
}
const prisma = {
  tenant: {
    async findUnique(args = {}) { return projectOrThrow(args); },
    async findFirst(args = {})  { return args && args.where && args.where.NOT ? null : projectOrThrow(args); },
    async findMany(args = {})   { return [projectOrThrow(args)]; },
    // The primary write at admin.js:287. It uses an explicit select
    // (TENANT_PUBLIC_SELECT) which omits waPin, so it SUCCEEDS under drift —
    // exactly like the real live DB. It must return the updated row projection.
    async update(args = {})     { return projectOrThrow(args); },
    async updateMany()          { return { count: 1 }; },
  },
  link: { async findMany() { return []; } },
};
export default prisma;
`;

function isPrismaModule(url) {
  return url.endsWith('/lib/prisma.js') || url.endsWith('\\lib\\prisma.js');
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (isPrismaModule(resolved.url)) {
    return { url: 'drift-prisma-wapin:stub', shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url === 'drift-prisma-wapin:stub') {
    return { format: 'module', source: STUB_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
