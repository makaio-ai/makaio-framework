/**
 * CLI entry point for Electrobun bundle invocation.
 *
 * Built as `dist/cli.mjs`. Platform launchers exec the bundled Bun binary
 * with this module, forwarding `process.argv` to the Makaio CLI program.
 */

declare const __MAKAIO_HOME_DEFAULT__: string;

import { applyDesktopMakaioHomeEnv } from '@makaio/host-shared/desktop-boot-context';
import { tryLightHookPath } from '@makaio/cli/hook-fast-path-detect';

const defaultMakaioHomeDir = typeof __MAKAIO_HOME_DEFAULT__ !== 'undefined' ? __MAKAIO_HOME_DEFAULT__ : undefined;
applyDesktopMakaioHomeEnv({
  env: process.env,
  ...(defaultMakaioHomeDir !== undefined ? { defaultDir: defaultMakaioHomeDir } : {}),
});

/**
 * Route hook invocations through the light path; run the full CLI otherwise.
 */
async function run(): Promise<void> {
  if (await tryLightHookPath(process.argv, () => import('@makaio/cli/hook-fast-path'))) return;

  const { main } = await import('@makaio/cli');
  await main();
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
