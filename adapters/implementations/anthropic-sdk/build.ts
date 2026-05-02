/**
 * Build script for the Anthropic SDK adapter.
 *
 * This adapter is Node-only due to its dependency on the Anthropic SDK which
 * requires Node.js APIs. The SDK is externalized as a peer dependency and
 * needs createRequire for CJS interop.
 */
import { build, createSingleTargetAdapterConfig } from '@makaio/build-tooling/adapter';

await build(
  createSingleTargetAdapterConfig('node', {
    packageRoot: import.meta.dirname,
    external: [/^@anthropic-ai\//],
    needsCreateRequire: true,
  }),
);
