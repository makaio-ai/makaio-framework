import { build } from 'tsdown';
import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

await build({
  ...defineExtensionConfig({
    entry: {
      index: './src/index.ts',
      'cli/index': './src/cli/index.ts',
      'cli/client-hook-command': './src/cli/client-hook-command.ts',
    },
  }),
});

emitDeclarations({ packageDir: import.meta.dirname });
