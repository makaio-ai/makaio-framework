/**
 * MakaioExtension descriptor for the devex-smoke E2E fixture.
 *
 * Wraps the fixture adapter and provider in the standard {@link MakaioExtension}
 * shape so the smoke harness can inject them via the unified descriptor-based
 * discovery path without requiring a real filesystem package.
 */
import type { MakaioExtension } from '@makaio/contracts';
import { adapterDefinition } from './adapter-fixture.js';
import { providerDefinition } from './provider-fixture.js';
import { DEVEX_SMOKE_ADAPTER_NAME } from './shared.js';

/**
 * Extension descriptor for the devex-smoke fixture adapter and provider.
 *
 * The manifest protocol entry uses `'openai'` as a structural placeholder —
 * the fixture adapter never routes through a real wire protocol. The
 * `providers` array is declared at the extension level because the devex-smoke
 * adapter wraps a standalone provider definition rather than a protocol-bundled one.
 */
const devexSmokeExtension: MakaioExtension = {
  name: 'devex-smoke-fixture',
  displayName: 'DevEx Smoke Fixture',
  providers: [providerDefinition],
  adapters: [
    {
      manifest: {
        name: DEVEX_SMOKE_ADAPTER_NAME,
        displayName: 'DevEx Smoke Adapter',
        description: 'Local-only adapter used by the CLI SDK smoke test',
        protocols: ['openai'],
      },
      definition: adapterDefinition,
    },
  ],
};

export default devexSmokeExtension;
