#!/usr/bin/env node
/**
 * Git hook receiver binary entry point.
 *
 * Invoked by native Git hook wrapper scripts to ingest a hook event and emit
 * it on the Makaio bus. The process always exits 0 (fail-open): Git must not
 * abort the in-progress operation because the receiver failed.
 * @packageDocumentation
 */

import { parseReceiverArgs } from '../receiver/args.js';
import { receiveGitHook } from '../receiver/receive.js';

try {
  await receiveGitHook(parseReceiverArgs(process.argv.slice(2)));
} catch (error) {
  if (process.env['MAKAIO_DEBUG'] === 'true') {
    console.error('[git-hook-receiver]', error);
  }
  // Fail-open: any unexpected error must not surface a non-zero exit code.
  process.exitCode = 0;
}
