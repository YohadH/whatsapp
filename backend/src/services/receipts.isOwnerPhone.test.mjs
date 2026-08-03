// Test for the tenant-scoped owner-phone recognition in the receipts pipeline.
// Run: node src/services/receipts.isOwnerPhone.test.mjs
//
// BUG (fixed): isOwnerPhone() OR'd the global HANDOFF_NOTIFY_PHONE into EVERY
// tenant's match, so a number equal to the global env was recognized as the
// "owner" of ANY tenant — cross-tenant receipt misattribution. The fix scopes
// recognition to the tenant's OWN ownerPhone; the global env is a last-resort
// default ONLY for tenants that have not configured an ownerPhone.
//
// Pure-function test: no DB, no network. isOwnerPhone reads only
// tenant.ownerPhone (arg) + config.handoff.notifyPhone (env at import time).

import assert from 'node:assert';

// Set the global env BEFORE importing the module (config reads env at import).
process.env.HANDOFF_NOTIFY_PHONE = '972500000000'; // the shared/global owner number

const { isOwnerPhone } = await import('./receipts.js');

// Two distinct tenants, each with its OWN configured owner phone.
const tenantA = { id: 'tnt_A', ownerPhone: '972501111111' };
const tenantB = { id: 'tnt_B', ownerPhone: '972502222222' };
// A tenant that has NOT configured an owner phone (should use the global default).
const tenantNone = { id: 'tnt_none', ownerPhone: null };

let passed = 0;
function check(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`  ok  ${name}`);
  passed++;
}

// ── Each tenant recognizes its OWN owner phone ──
check('tenant A recognizes its own owner phone', isOwnerPhone(tenantA, '972501111111'));
check('tenant B recognizes its own owner phone', isOwnerPhone(tenantB, '972502222222'));
// Suffix-tolerant (IL local form of the same number).
check('tenant A recognizes its own phone in IL-local form', isOwnerPhone(tenantA, '0501111111'));

// ── A configured tenant does NOT match the global env number (the core bug) ──
check("tenant A does NOT match the GLOBAL env number (no cross-tenant leak)",
  isOwnerPhone(tenantA, '972500000000') === false);
check("tenant B does NOT match the GLOBAL env number (no cross-tenant leak)",
  isOwnerPhone(tenantB, '972500000000') === false);

// ── A configured tenant does NOT match ANOTHER tenant's owner phone ──
check("tenant A does NOT match tenant B's owner phone",
  isOwnerPhone(tenantA, '972502222222') === false);
check("tenant B does NOT match tenant A's owner phone",
  isOwnerPhone(tenantB, '972501111111') === false);

// ── The global env is a fallback ONLY for a tenant with no ownerPhone ──
check('unconfigured tenant falls back to the global env number',
  isOwnerPhone(tenantNone, '972500000000'));
check('unconfigured tenant does NOT match some other tenant owner number',
  isOwnerPhone(tenantNone, '972501111111') === false);

// ── Random third-party number is never the owner ──
check('random number is not tenant A owner', isOwnerPhone(tenantA, '972509999999') === false);
check('empty phone is never the owner', isOwnerPhone(tenantA, '') === false);

// ── Regression guard: demonstrate the OLD behavior would have leaked ──
// The pre-fix logic was: samePhone(tenant.ownerPhone,phone) || samePhone(GLOBAL,phone)
// For tenant A + the GLOBAL number, the OLD OR would return true (the bug).
// Reconstruct the OLD predicate here and assert the NEW code diverges from it —
// proving this test is discriminating (would fail against the buggy code).
const oldBuggyPredicate = (t, phone) => {
  const d = (v) => String(v || '').replace(/\D/g, '');
  const same = (a, b) => {
    const da = d(a), db = d(b);
    if (!da || !db) return false;
    if (da === db) return true;
    const sa = da.slice(-9);
    return sa.length === 9 && sa === db.slice(-9);
  };
  return same(t?.ownerPhone, phone) || same('972500000000', phone);
};
check('regression: OLD buggy predicate WOULD have leaked the global to tenant A',
  oldBuggyPredicate(tenantA, '972500000000') === true);
check('regression: NEW code does NOT leak the global to tenant A (fix confirmed)',
  isOwnerPhone(tenantA, '972500000000') === false);

console.log(`\nPASS: ${passed} assertions — isOwnerPhone is tenant-scoped, no cross-tenant misattribution`);
