import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';
import { frameworkReactPreset } from '@makaio/build-tooling/tsdown-framework-preset';
import { createMakaioScssImporter } from '@makaio/build-tooling/tsdown-scss';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** Absolute path to the workspace node_modules for SCSS import resolution. */
const nodeModulesDir = path.join(resolveWorkspaceRoot(packageRoot), 'node_modules');

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
