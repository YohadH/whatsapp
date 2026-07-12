// Apply a .sql file to the Supabase/PostgreSQL database in DATABASE_URL.
//   node supabase/apply.js [path-to-sql]   (defaults to supabase/schema.sql)
//
// Uses the `pg` driver directly so multi-statement files with functions,
// dollar-quoted bodies, and DO blocks run as-is (Prisma's raw exec can't).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, 'schema.sql');

// Strip Prisma-only query params (pgbouncer, connection_limit) that pg rejects.
const connectionString = process.env.DATABASE_URL.split('?')[0];
const sql = fs.readFileSync(sqlPath, 'utf8');

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Supabase pooler requires TLS
});

try {
  await client.connect();
  await client.query(sql);
  console.log(`✅ Applied ${path.relative(process.cwd(), sqlPath)}`);
} catch (err) {
  console.error('❌ Failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
