import { build } from 'tsdown';
import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

await build({
  ...defineExtensionConfig({
    entry: {
      index: './src/index.ts',
      cli: './src/cli.ts',
    },
  }),
});

emitDeclarations({ packageDir: import.meta.dirname });
