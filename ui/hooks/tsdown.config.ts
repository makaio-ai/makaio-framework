import { defineConfig } from 'tsdown';
import { frameworkReactPreset } from '@makaio/build-tooling/tsdown-framework-preset';

export default defineConfig({
  ...frameworkReactPreset,
  entry: ['./src/index.ts'],
});
