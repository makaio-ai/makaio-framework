import { defineAdapterConfig } from '@makaio/build-tooling/tsdown-adapter-preset';

export default defineAdapterConfig({
  external: [/^@github\//, 'p-defer', 'p-queue', 'quick-lru'],
});
