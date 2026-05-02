import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'tsdown';
import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';
import { createRepoDevAliases, isRepoDevMode } from './scripts/package-mode.js';

const baseConfig = defineExtensionConfig({
  entry: {
    cli: './src/cli.ts',
  },
});

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));

export default isRepoDevMode()
  ? mergeConfig(baseConfig, {
      alias: createRepoDevAliases(extensionRoot),
    })
  : baseConfig;
