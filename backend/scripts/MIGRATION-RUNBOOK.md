# Tenant Migration Runbook — live Supabase production DB

**Status:** SAFETY NET BUILT — not yet run against live. This runbook + the three
`migrate-0*.mjs` scripts are the reviewed, transaction-wrapped path the owner asked
for before re-approving the live migration. Running it against production still
requires an explicit owner OK (the owner DENIED an unguarded run on 2026-07-17,
`decisions/decision-log.md`).

## Why this exists
On 2026-07-16 a multi-tenant schema was added (Tenant table + `tenantId` columns),
but the live Supabase DB (~18k rows: Customer≈1432, Message≈3377, AnalyticsEvent≈10137,
OutboundSend≈1800) was never migrated — that is **BUG-WA-002**. The `AdminUser.tenantId`
+ `mustResetPassword` columns were already applied out-of-band (login works); the
rest of the domain tables are still un-migrated, so tenant-scoped routes fail
(P2021/P2022). The final step (SET NOT NULL, DROP `Customer_phone_key`) is
**irreversible on live data**, which is exactly why the owner denied the earlier
"just run the backfill" ask. These scripts add the backup + verify + rollback net.

## Connection discipline (critical)
- The app's `backend/.env` `DATABASE_URL` is the **pgBouncer pooler** (`...pooler.supabase.com:6543?pgbouncer=true`).
  **Do NOT run backup or DDL through it.** DDL and `pg_dump` need the **DIRECT**
  connection (**5432**, no `pgbouncer` param).
- All three scripts read the direct URL from a **separate, explicit** env var
  `MIGRATION_DIRECT_URL`, never from `DATABASE_URL`, and each **refuses** a URL
  containing `:6543` / `pgbouncer=true`.
- Get the direct URL from Supabase: Project → Settings → Database → **Connection
  string → "Direct connection" (port 5432)**. Pass it inline for the one run:
  `MIGRATION_DIRECT_URL="postgresql://...:5432/postgres" node scripts/migrate-0X.mjs --live`

## Run order (do NOT skip or reorder)

### Step 1 — schema columns already applied
`Tenant` table + nullable `tenantId` columns exist (SQL migration, applied live for
AdminUser). Nothing to run here; confirm the columns are present.

### Step 0 — PREFLIGHT BACKUP (must succeed before anything irreversible)
```
# dry-run first (validates env, connects to nothing):
node scripts/migrate-01-backup.mjs
# then the real backup:
MIGRATION_DIRECT_URL="postgresql://...:5432/postgres" node scripts/migrate-01-backup.mjs --live
```
- Produces `backend/backups/whatsapp-YYYYMMDD*.dump` (custom format `-Fc`) and
  verifies it with `pg_restore --list`. Exits non-zero if no usable dump is made.
- **If `pg_dump` is not installed** (it is NOT present in the agent sandbox): take
  the backup via the **Supabase Dashboard** (Project → Database → Backups →
  download a manual backup, or confirm PITR is on). Record the backup id/time
  **here** in the runbook, then run step 3 with `--backup-confirmed`.

Backup taken: `__________________________` (fill in id/time before step 3).

### Step 2 — BACKFILL (idempotent, safe to re-run)
```
node scripts/backfill-tenants.mjs
```
Creates/reuses the `default` tenant and sets `tenantId` on every `tenantId IS NULL`
row, table by table (per-table try/catch, `UPDATE ... WHERE tenantId IS NULL`).
> Note: `backfill-tenants.mjs` reads the app's `prisma` client (`DATABASE_URL`).
> The pooler is fine for row `UPDATE`s (it is only DDL/`pg_dump` that need 5432).
> `AdminUser.tenantId` stays nullable by design (super_admin = null).

### Step 2.5 — 0-NULL VERIFY GATE (must pass before step 3)
```
node scripts/migrate-02-verify-no-nulls.mjs                       # dry-run: lists tables
MIGRATION_DIRECT_URL="postgresql://...:5432/postgres" \
  node scripts/migrate-02-verify-no-nulls.mjs --live             # real counts
```
- Counts `tenantId IS NULL` for every gated table (all backfilled tables except
  `AdminUser`). **Exits non-zero and names the offending table** if any NULLs
  remain. Do not proceed to step 3 until this prints `0-NULL GATE PASSED`.

### Step 3 — FINALIZE (IRREVERSIBLE — one transaction, rolls back on any error)
```
node scripts/migrate-03-finalize.mjs                              # dry-run: prints exact SQL
MIGRATION_DIRECT_URL="postgresql://...:5432/postgres" \
  node scripts/migrate-03-finalize.mjs --live                    # runs inside a transaction
# use --backup-confirmed instead of a local .dump if backup was via Supabase Dashboard
```
Inside a single `prisma.$transaction` (all-or-nothing):
1. `ALTER TABLE ... ALTER COLUMN "tenantId" SET NOT NULL` for the 12 gated tables.
2. `ALTER TABLE "Customer" DROP CONSTRAINT IF EXISTS "Customer_phone_key"` (old
   global-phone unique → replaced by per-tenant unique).
3. `CREATE UNIQUE INDEX IF NOT EXISTS` for `Customer(tenantId,phone)`,
   `SuppressedNumber(tenantId,phone)`, `Message(tenantId,waMessageId)` — mirrors
   the `@@unique(...)` blocks in `schema.prisma`.

Preconditions the script self-enforces before opening the transaction: direct
(5432) URL, backup present (`.dump` file or `--backup-confirmed`), and the 0-NULL
gate passing inline. If any DDL statement fails, the **whole transaction rolls back**
and the schema is left unchanged.

### Step 4 — post-migration QA
Boot the backend and smoke-test the previously-down tenant-scoped routes
(`/api/flows`, `/api/conversations`, `/api/knowledge-base`, `/api/links`,
`/api/analytics`, `/api/broadcast`) — they should return data instead of
P2021/P2022. Then mark BUG-WA-002 RESOLVED with the commit SHA.

## Rollback
- Before step 3: re-running is safe (backfill is idempotent; verify is read-only).
- If step 3's transaction fails: it already rolled back — schema unchanged, just fix
  and re-run.
- If step 3 committed but you must revert: restore from the step-0 backup
  (`pg_restore` from the `.dump`, or Supabase Dashboard restore to the recorded
  backup id). This is why step 0 is a hard precondition.
