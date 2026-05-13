import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';

export default defineExtensionConfig({
  entry: {
    index: './src/index.ts',
    server: './src/server.ts',
    'bus/schemas': './src/bus/schemas.ts',
    'bus/namespace': './src/bus/namespace.ts',
  },
});
