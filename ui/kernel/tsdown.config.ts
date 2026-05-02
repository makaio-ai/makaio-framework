import { defineConfig } from 'tsdown';
import { frameworkPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkPreset,
  entry: ['./src/index.ts', './src/pages/schemas.ts', './src/pages/namespace.ts'],
});
