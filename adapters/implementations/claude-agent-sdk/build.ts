import { build } from 'tsdown';
import { defineAdapterConfig } from '@makaio/build-tooling/tsdown-adapter-preset';

await build(
  defineAdapterConfig({
    external: [/^@anthropic-ai\//, 'p-defer', 'p-queue'],
    needsCreateRequire: true,
  }),
);
