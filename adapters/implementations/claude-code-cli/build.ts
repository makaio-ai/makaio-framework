/**
 * Build script for the Claude Code CLI adapter.
 *
 * This adapter is Node-only because it spawns the Claude CLI over stdio.
 */
import { build, createSingleTargetAdapterConfig } from '@makaio/build-tooling/adapter';

await build(
  createSingleTargetAdapterConfig('node', {
    packageRoot: import.meta.dirname,
  }),
);
