import { build } from 'tsdown';
import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

await build({
  ...defineExtensionConfig({
    entry: {
      index: './src/index.ts',
      'contracts/index': './src/contracts/index.ts',
      'contracts/namespace': './src/contracts/namespace.ts',
    },
  }),
});

emitDeclarations({ packageDir: import.meta.dirname });
