import { build } from 'tsdown';
import { defineAdapterConfig } from '@makaio/build-tooling/tsdown-adapter-preset';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

await build({
  ...defineAdapterConfig({
    entry: {
      browser: './src/browser/index.ts',
      server: './src/server.ts',
      cli: './src/cli.ts',
    },
    external: ['ink', 'react'],
  }),
  dts: false,
});

emitDeclarations({ packageDir: import.meta.dirname });
