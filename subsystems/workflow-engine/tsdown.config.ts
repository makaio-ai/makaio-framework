import { defineConfig } from 'tsdown';
import { frameworkPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkPreset,
  dts: { eager: true },
  entry: ['./src/index.ts', './src/package.ts'],
});
