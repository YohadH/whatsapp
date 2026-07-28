// Registers the google-integration ESM loader hook. Use as:
//   node --import ./scripts/register-google-integration-loader.mjs ./scripts/googleIntegration.test.mjs
import { register } from 'node:module';

register('./google-integration-loader.mjs', import.meta.url);
