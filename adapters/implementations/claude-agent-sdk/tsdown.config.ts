import { defineAdapterConfig } from '@makaio/build-tooling/tsdown-adapter-preset';

export default defineAdapterConfig({
  external: [/^@anthropic-ai\//, 'p-defer', 'p-queue'],
  needsCreateRequire: true,
});
