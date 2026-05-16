import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/shared/index.ts', './src/core/index.ts', './src/runtime/index.ts'],
  format: 'esm',
  dts: true,
  minify: true,
});
