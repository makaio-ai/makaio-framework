import { defineAdapterConfig } from '@makaio/build-tooling/tsdown-adapter-preset';

export default defineAdapterConfig({
  external: [/^@google\//, 'zod', 'p-queue'],
});
