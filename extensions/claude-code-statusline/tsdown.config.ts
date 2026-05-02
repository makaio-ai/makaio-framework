import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';

export default defineExtensionConfig({
  entry: {
    server: './src/server.ts',
    cli: './src/cli.ts',
  },
});
