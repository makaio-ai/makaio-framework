import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'tsdown';
import { defineExtensionConfig } from '@makaio/build-tooling/tsdown-extension-preset';
import { createRepoDevAliases, isRepoDevMode } from './scripts/package-mode.js';

const baseConfig = defineExtensionConfig({
  entry: {
    browser: './src/browser/index.ts',
    server: './src/server.ts',
    cli: './src/cli.ts',
  },
  nativeModules: ['@napi-rs/keyring'],
  external: ['ink', 'react'],
});

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));

export default isRepoDevMode()
  ? mergeConfig(baseConfig, {
      alias: createRepoDevAliases(extensionRoot),
    })
  : baseConfig;
