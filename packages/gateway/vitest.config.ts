import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// Resolve sibling workspace packages to their SOURCE, so tests run without a
// build step and stack traces point at real files.
export default defineConfig({
  resolve: {
    alias: {
      '@storeagent/attribution': `${here}../attribution/src/index.ts`,
      '@storeagent/grounding': `${here}../grounding/src/index.ts`,
      '@storeagent/orchestrator': `${here}../orchestrator/src/index.ts`,
      '@storeagent/ucp-client': `${here}../ucp-client/src/index.ts`,
      '@storeagent/voice': `${here}../voice/src/index.ts`,
    },
  },
});
