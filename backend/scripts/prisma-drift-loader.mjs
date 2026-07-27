// ESM loader hook that replaces `../lib/prisma.js` (as imported by
// src/middleware/tenant.js) with a stub emulating a live DB that is one migration
// BEHIND schema.prisma: an implicit SELECT * (findUnique with no `select`) throws
// Prisma P2022 for a phantom, not-yet-migrated column; an explicit `select` that
// omits that column succeeds. Used by sim-tenant-select-drift.mjs to run the REAL
// withTenant() middleware against the drift.
//
// Registered via:  node --import ./scripts/register-drift-loader.mjs <script>
import { pathToFileURL } from 'node:url';

const PHANTOM_COLUMN = 'newlyAddedCol';

const LIVE_ROW = {
  id: 'tnt_demo',
  status: 'active',
  waPhoneNumberId: '123',
  waBusinessAccountId: 'waba_1',
  waTokenEnc: null,
  waApiVersion: 'v21.0',
  dailyBroadcastCap: 250,
  monthlyMessageLimit: 1000,
  creditsUsedThisPeriod: 0,
  purchasedCredits: 0,
  periodStartedAt: new Date().toISOString(),
  lowCreditNotifiedAt: null,
  // deliberately NO `newlyAddedCol` — it isn't on the live DB.
};

const STUB_SOURCE = `
const PHANTOM_COLUMN = ${JSON.stringify(PHANTOM_COLUMN)};
const LIVE_ROW = ${JSON.stringify(LIVE_ROW)};
function p2022() {
  const err = new Error('Invalid \`prisma.tenant.findUnique()\`: The column \`Tenant.' + PHANTOM_COLUMN + '\` does not exist in the current database.');
  err.code = 'P2022';
  err.meta = { column: 'Tenant.' + PHANTOM_COLUMN };
  return err;
}
const prisma = {
  tenant: {
    async findUnique(args = {}) {
      const select = args && args.select;
      if (!select) throw p2022();               // SELECT * → asks for phantom col
      if (select[PHANTOM_COLUMN]) throw p2022(); // explicit but lists phantom
      const out = {};
      for (const k of Object.keys(select)) if (select[k]) out[k] = LIVE_ROW[k];
      return out;
    },
  },
};
export default prisma;
`;

// Match any resolved specifier ending in /lib/prisma.js
function isPrismaModule(url) {
  return url.endsWith('/lib/prisma.js') || url.endsWith('\\lib\\prisma.js');
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (isPrismaModule(resolved.url)) {
    return { url: 'drift-prisma:stub', shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url === 'drift-prisma:stub') {
    return { format: 'module', source: STUB_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
