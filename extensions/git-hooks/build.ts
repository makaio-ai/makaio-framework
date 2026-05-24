import { build } from 'tsdown';
import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

await build({
  ...defineExtensionConfig({
    entry: {
      index: './src/index.ts',
      server: './src/server.ts',
      'cli/index': './src/cli/index.ts',
      'bin/git-hook-receiver': './src/bin/git-hook-receiver.ts',
    },
  }),
});

emitDeclarations({ packageDir: import.meta.dirname });
