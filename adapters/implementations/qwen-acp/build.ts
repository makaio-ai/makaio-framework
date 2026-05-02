/**
 * Build script for the Qwen ACP adapter.
 *
 * This adapter is Node-only due to its dependency on the Qwen CLI process
 * and the ACP (Agent Communication Protocol) SDK.
 */
import { build, createSingleTargetAdapterConfig } from '@makaio/build-tooling/adapter';

await build(
  createSingleTargetAdapterConfig('node', {
    packageRoot: import.meta.dirname,
    external: [/^@agentclientprotocol\//],
  }),
);
