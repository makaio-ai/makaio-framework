/**
 * CLI entry point for Electrobun bundle invocation.
 *
 * Built as `dist/cli.mjs`. Platform launchers exec the bundled Bun binary
 * with this module, forwarding `process.argv` to the Makaio CLI program.
 *
 * Sets MAKAIO_HOME from the build-time default when the user hasn't overridden
 * it, ensuring canary CLI uses an isolated data directory.
 */

declare const __MAKAIO_HOME_DEFAULT__: string;

import * as os from 'node:os';
import * as path from 'node:path';

if (!process.env['MAKAIO_HOME']?.trim() && typeof __MAKAIO_HOME_DEFAULT__ !== 'undefined') {
  process.env['MAKAIO_HOME'] = path.join(os.homedir(), __MAKAIO_HOME_DEFAULT__);
}

import { main } from '@makaio/cli';

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
