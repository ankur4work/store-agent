import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// Resolve sibling workspace packages to their SOURCE, so tests run without a
// build step and stack traces point at real files.
export default defineConfig({
  resolve: {
    alias: {
      '@storeagent/attribution': `${here}../attribution/src/index.ts`,
      '@storeagent/billing': `${here}../billing/src/index.ts`,
      '@storeagent/grounding': `${here}../grounding/src/index.ts`,
      '@storeagent/resilience': `${here}../resilience/src/index.ts`,
      '@storeagent/orchestrator': `${here}../orchestrator/src/index.ts`,
      '@storeagent/ucp-client': `${here}../ucp-client/src/index.ts`,
      '@storeagent/voice': `${here}../voice/src/index.ts`,
    },
  },
  // Vite's list of Node builtins predates `node:sqlite`, so it strips the
  // `node:` prefix and then looks for an npm package called `sqlite`. Mark it
  // external explicitly; `ssr.external` alone does not help, because the
  // failure happens during resolution.
  plugins: [
    {
      name: 'external-node-sqlite',
      enforce: 'pre',
      resolveId(id: string) {
        if (id === 'node:sqlite' || id === 'sqlite') {
          return { id: 'node:sqlite', external: true };
        }
        return null;
      },
    },
  ],
});
