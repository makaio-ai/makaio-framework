/**
 * Build script for the GitHub Copilot SDK adapter.
 *
 * This adapter is Node-only since it uses Node.js APIs for the Copilot SDK.
 */
import { build, createSingleTargetAdapterConfig } from '@makaio/build-tooling/adapter';

await build(
  createSingleTargetAdapterConfig('node', {
    packageRoot: import.meta.dirname,
    external: [/^@github\//, 'p-defer', 'p-queue', 'quick-lru'],
  }),
);
