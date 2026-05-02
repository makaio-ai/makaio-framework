import { defineConfig } from 'tsdown';
import { frameworkPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkPreset,
  entry: ['./src/config/index.ts', './src/index.ts', './src/node.ts'],
});
