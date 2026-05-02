/**
 * Standalone entry point for the CLI serve command.
 *
 * Used exclusively by the E2E harness to spawn a real CLI serve process via
 * `tsx`. This file calls {@link main} with `serve --port 0` arguments so the
 * OS assigns a free port (CI-safe). The bound port is announced via
 * `MAKAIO_PORT=<n>` on stdout by the serve composition root.
 *
 * Do NOT import from the application code path — this file is only ever
 * spawned as a child process.
 */
import { ExplicitDescriptorDiscovery } from '@makaio/runtime-node';
import { main } from '../../src/main.js';

// Top-level await is valid in ESM modules.
// Pass synthetic argv matching `process.argv` convention: [node, script, ...args]
await main(['node', 'cli-serve-entry.ts', 'serve', '--port', '0'], [], undefined, {
  boot: {
    discovery: new ExplicitDescriptorDiscovery([]),
  },
});
