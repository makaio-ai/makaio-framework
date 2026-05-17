import { build } from 'tsdown';
import { defineAdapterConfig } from '@makaio/build-tooling/tsdown-adapter-preset';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

await build({
  ...defineAdapterConfig({
    entry: {
      index: './src/index.ts',
      server: './src/server.ts',
      cli: './src/cli.ts',
    },
  }),
  dts: false,
});

emitDeclarations({ packageDir: import.meta.dirname });
