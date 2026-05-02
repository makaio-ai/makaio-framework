/**
 * Build script for the Claude Code adapter.
 *
 * This adapter is Node-only due to its dependency on the Claude Agent SDK
 * which requires Node.js APIs (child_process, fs, etc.).
 */
import { build, createSingleTargetAdapterConfig } from '@makaio/build-tooling/adapter';

const packageRoot = import.meta.dirname;

// Node-only build - Claude Agent SDK requires Node.js
await build(
  createSingleTargetAdapterConfig('node', {
    packageRoot,
    needsCreateRequire: true,
    // Externalize Claude SDK (Node-only) and its heavy dependencies
    external: [/^@anthropic-ai\//, 'p-defer', 'p-queue'],
  }),
);
