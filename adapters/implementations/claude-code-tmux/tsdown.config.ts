import { defineAdapterConfig } from '@makaio/build-tooling/tsdown-adapter-preset';

// The adapter preset rewrites framework-owned workspace imports to
// `@makaio/framework/<subpath>` and externalizes that aggregate peer.
// Internal `@makaio/*` imports therefore remain devDependencies here, matching
// the published-adapter contract used by the other framework adapters.
export default defineAdapterConfig();
