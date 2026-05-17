import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';

export default defineExtensionConfig({
  entry: {
    index: './src/index.ts',
    server: './src/server.ts',
    cli: './src/cli.ts',
  },
});
