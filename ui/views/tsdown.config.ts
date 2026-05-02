import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';
import { frameworkReactPreset } from '@makaio/build-tooling/tsdown-framework-preset';
import { createMakaioScssImporter } from '@makaio/build-tooling/tsdown-scss';

/** Absolute path to the workspace node_modules for SCSS import resolution. */
const nodeModulesDir = path.resolve(fileURLToPath(new URL('../../../node_modules', import.meta.url)));
const workspaceRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export default defineConfig({
  ...frameworkReactPreset,
  entry: ['./src/index.ts'],
  css: {
    preprocessorOptions: {
      scss: {
        loadPaths: [nodeModulesDir],
        importers: [createMakaioScssImporter(workspaceRoot)],
      },
    },
  },
});
