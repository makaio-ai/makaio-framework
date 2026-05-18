/**
 * CLI entry point for Electrobun bundle invocation.
 *
 * Built as `dist/cli.mjs`. Platform launchers exec the bundled Bun binary
 * with this module, forwarding `process.argv` to the Makaio CLI program.
 */

declare const __MAKAIO_HOME_DEFAULT__: string;

import { seedMakaioHome } from './makaio-home.js';

seedMakaioHome(typeof __MAKAIO_HOME_DEFAULT__ !== 'undefined' ? __MAKAIO_HOME_DEFAULT__ : undefined);

import { main } from '@makaio/cli';

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
