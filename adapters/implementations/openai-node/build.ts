/**
 * Build script for the OpenAI Node adapter.
 *
 * This adapter is Node-only since it uses the OpenAI Node SDK.
 */
import { build, createSingleTargetAdapterConfig } from '@makaio/build-tooling/adapter';

await build(
  createSingleTargetAdapterConfig('node', {
    packageRoot: import.meta.dirname,
    external: ['openai'],
  }),
);
