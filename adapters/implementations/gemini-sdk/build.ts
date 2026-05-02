/**
 * Build script for the Gemini SDK adapter.
 *
 * This adapter is Node-only due to dependencies on node:fs and node:crypto
 * for config management and session handling.
 */
import { build, createSingleTargetAdapterConfig } from '@makaio/build-tooling/adapter';

await build(
  createSingleTargetAdapterConfig('node', {
    packageRoot: import.meta.dirname,
    external: [/^@google\//, 'zod', 'p-queue'],
  }),
);
