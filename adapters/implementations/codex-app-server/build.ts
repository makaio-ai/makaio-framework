/**
 * Build script for the Codex app-server adapter.
 *
 * This adapter is Node-only because it communicates with the Codex app-server
 * subprocess over stdio.
 */
import { build, createSingleTargetAdapterConfig } from '@makaio/build-tooling/adapter';

await build(
  createSingleTargetAdapterConfig('node', {
    packageRoot: import.meta.dirname,
  }),
);
