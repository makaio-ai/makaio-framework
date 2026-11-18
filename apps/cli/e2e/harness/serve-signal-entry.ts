/**
 * CLI serve entry for the signal-handling E2E tests.
 *
 * Runs the real `makaio serve` command path (extra CLI arguments are forwarded,
 * so `--ignore-hangup` reaches the command) with the fixture extensions of
 * `signal-fixtures.ts`.
 *
 * Do NOT import from the application code path — this file is only ever
 * spawned as a child process.
 */
import { main } from '../../src/main.js';
import { createSignalFixtureDiscovery, holdBootIfRequested } from './signal-fixtures.js';

holdBootIfRequested();

await main(['node', 'serve-signal-entry.ts', 'serve', '--port', '0', ...process.argv.slice(2)], [], undefined, {
  boot: { discovery: createSignalFixtureDiscovery() },
});
