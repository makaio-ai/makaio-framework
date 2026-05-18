/**
 * CLI entry point for Electrobun bundle invocation.
 *
 * Built as `dist/cli.mjs`. Platform launchers exec the bundled Bun binary
 * with this module, forwarding `process.argv` to the Makaio CLI program.
 */

declare const __MAKAIO_HOME_DEFAULT__: string;

import { applyDesktopMakaioHomeEnv } from '@makaio/host-shared';

const defaultMakaioHomeDir = typeof __MAKAIO_HOME_DEFAULT__ !== 'undefined' ? __MAKAIO_HOME_DEFAULT__ : undefined;
applyDesktopMakaioHomeEnv({
  env: process.env,
  ...(defaultMakaioHomeDir !== undefined ? { defaultDir: defaultMakaioHomeDir } : {}),
});

import { main } from '@makaio/cli';

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
