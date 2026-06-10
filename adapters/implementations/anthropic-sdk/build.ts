import { build } from 'tsdown';
import { defineAdapterConfig } from '@makaio/build-tooling/tsdown-adapter-preset';

await build(
  defineAdapterConfig({
    // The `server` entry must be built so the published package contains
    // `dist/server.mjs` — extension discovery resolves the descriptor's
    // `entrypoints.server: true` to `src/server.ts` (dev) or `dist/server.mjs`
    // (published). Same pattern as @makaio/provider-anthropic.
    entry: {
      index: './src/index.ts',
      server: './src/server.ts',
    },
    external: [/^@anthropic-ai\//],
    needsCreateRequire: true,
  }),
);
