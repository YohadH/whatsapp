// Registers the handoff-notify ESM loader hook. Use as:
//   node --import ./scripts/register-handoff-notify-loader.mjs ./scripts/handoff-notify-toctou.test.mjs
import { register } from 'node:module';

register('./handoff-notify-loader.mjs', import.meta.url);
