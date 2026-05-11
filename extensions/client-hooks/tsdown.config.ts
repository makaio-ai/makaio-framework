import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';

export default defineExtensionConfig({
  entry: {
    index: './src/index.ts',
    cli: './src/cli/index.ts',
  },
});
