import { PrismaClient } from '@prisma/client';

// PostgreSQL (Supabase) stores tags / triggerWords / options / metadata /
// rawPayload as native jsonb, so Prisma reads and writes them as plain
// arrays/objects. No (de)serialization middleware is needed.
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export default prisma;
