// Registers the non-BYO platform-OpenAI fallback ESM loader hook. Use as:
//   node --import ./scripts/register-non-byo-fallback-loader.mjs ./scripts/non-byo-platform-fallback.test.mjs
import { register } from 'node:module';

register('./non-byo-platform-fallback-loader.mjs', import.meta.url);
