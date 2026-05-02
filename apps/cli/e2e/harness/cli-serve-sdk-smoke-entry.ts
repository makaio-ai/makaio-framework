/**
 * CLI serve entry for the SDK example smoke test.
 *
 * Uses the real `makaio serve` command path, but injects a tiny fake provider
 * and adapter through descriptor discovery so the test can run
 * fully offline.
 */
import { fileURLToPath } from 'node:url';
import { ExplicitDescriptorDiscovery } from '@makaio/runtime-node';
import { main } from '../../src/main.js';

/** Internal extension name for the devex-smoke fixture. */
const DEVEX_SMOKE_EXTENSION_NAME = 'devex-smoke-fixture';
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/devex-smoke/', import.meta.url));

/**
 * Descriptor for the devex-smoke fixture loaded from the local filesystem.
 */
const DEVEX_SMOKE_DESCRIPTOR = {
  descriptor: {
    name: DEVEX_SMOKE_EXTENSION_NAME,
    displayName: 'DevEx Smoke Fixture',
    version: '0.0.0',
    makaio: { minVersion: '0.1.0' },
    entrypoints: { server: true as const },
  },
  extensionPath: FIXTURE_DIR,
  source: 'local' as const,
};

await main(['node', 'cli-serve-sdk-smoke-entry.ts', 'serve', '--port', '0'], [], undefined, {
  boot: {
    discovery: new ExplicitDescriptorDiscovery([DEVEX_SMOKE_DESCRIPTOR]),
  },
});
