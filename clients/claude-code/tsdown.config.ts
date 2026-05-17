import { defineConfig } from 'tsdown';
import { frameworkPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkPreset,
  entry: {
    index: './src/index.ts',
    'runtime/package': './src/runtime/package.ts',
    server: './src/server.ts',
  },
});
