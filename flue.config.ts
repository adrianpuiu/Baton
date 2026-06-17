import { defineConfig } from '@flue/cli/config';

// Target: Node.js (a single bundled .mjs). Switch to 'cloudflare' to deploy
// the same workflows to Cloudflare Workers + Durable Objects.
export default defineConfig({
  target: 'node',
});
