/**
 * Build script for the Pi SDK adapter.
 *
 * This adapter is Node-only due to its dependency on the Pi coding agent SDK
 * which requires Node.js APIs.
 */
import { build, createSingleTargetAdapterConfig } from '@makaio/build-tooling/adapter';

await build(
  createSingleTargetAdapterConfig('node', {
    packageRoot: import.meta.dirname,
    external: [/^@mariozechner\//],
  }),
);
