// Registers the prisma-drift ESM loader hook. Use as:
//   node --import ./scripts/register-drift-loader.mjs ./scripts/sim-tenant-select-drift.mjs
import { register } from 'node:module';

register('./prisma-drift-loader.mjs', import.meta.url);
