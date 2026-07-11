import { defineConfig } from 'tsdown';
import { frameworkPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkPreset,
  entry: {
    index: './src/index.ts',
    'managed-install': './src/managed-install.ts',
  },
});
