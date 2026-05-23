import { build } from 'tsdown';
import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

await build({
  ...defineExtensionConfig({
    entry: {
      index: './src/index.ts',
      server: './src/server.ts',
      browser: './src/browser.ts',
      testing: './src/testing.ts',
    },
  }),
});

emitDeclarations({ packageDir: import.meta.dirname });
