/**
 * CLI entry point for Electrobun bundle invocation.
 *
 * Built as `dist/cli.mjs`. Platform launchers exec the bundled Bun binary
 * with this module, forwarding `process.argv` to the Makaio CLI program.
 */
import { main } from '@makaio/cli';

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
