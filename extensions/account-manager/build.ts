import { build } from 'tsdown';
import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

await build({
  ...defineExtensionConfig({
    entry: {
      browser: './src/browser/index.ts',
      server: './src/server.ts',
      cli: './src/cli.ts',
    },
    external: [/^ink($|\/)/, /^react($|\/)/],
  }),
});

emitDeclarations({ packageDir: import.meta.dirname });
