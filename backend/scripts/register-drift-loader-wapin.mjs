// Registers the waPin-specific prisma-drift ESM loader hook. Use as:
//   node --import ./scripts/register-drift-loader-wapin.mjs ./scripts/sim-admin-wapin-degrade.mjs
import { register } from 'node:module';

register('./prisma-drift-loader-wapin.mjs', import.meta.url);
