import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';
import { frameworkReactPreset } from '@makaio/build-tooling/tsdown-framework-preset';

/** Absolute path to the workspace node_modules for SCSS import resolution. */
const nodeModulesDir = path.resolve(fileURLToPath(new URL('../../../node_modules', import.meta.url)));

export default defineConfig({
  ...frameworkReactPreset,
  entry: ['./src/index.ts'],
  css: {
    preprocessorOptions: {
      scss: {
        loadPaths: [nodeModulesDir],
      },
    },
  },
});
