import { defineConfig } from 'tsdown';
import { frameworkBusPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkBusPreset,
  entry: ['./src/index.ts'],
});
