import { build } from 'tsdown';
import { defineAdapterConfig } from '@makaio/build-tooling/tsdown-adapter-preset';

await build(
  defineAdapterConfig({
    entry: {
      index: './src/index.ts',
      server: './src/server.ts',
    },
    external: [/^@mariozechner\//],
  }),
);
