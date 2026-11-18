/**
 * CLI command entry for the signal-handling E2E tests.
 *
 * Runs the real CLI router with a fixture command (`signal-fixture hold`) whose
 * `provideBus` is the real embedded runtime provider of the workflow extension,
 * booted with the fixture extensions of `signal-fixtures.ts`. So the router's
 * signal context, the provider's lifecycle handle and the runtime boot are the
 * production code; only the command's handler is the fixture: it holds until the
 * invocation signal aborts (or, when asked to, never returns).
 *
 * Do NOT import from the application code path — this file is only ever
 * spawned as a child process.
 */
import { z } from 'zod';
import { ALWAYS_PROCEED, defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
import { bootEmbeddedWorkflowRuntime } from '../../../../extensions/workflow/src/embedded-workflow-runtime.js';
import { main } from '../../src/main.js';
import { COMMAND_IGNORES_ABORT_ENV } from './serve-signal-env.js';
import { createSignalFixtureDiscovery, holdBootIfRequested } from './signal-fixtures.js';

const holdCommand = defineCliSubcommand(
  'hold',
  'Hold until the invocation signal aborts',
  z.object({}),
  async (ctx) => {
    console.info('[fixture] command running');
    if (process.env[COMMAND_IGNORES_ABORT_ENV] === '1') {
      await new Promise<void>(() => undefined);
    }
    await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
    console.info(`[fixture] command observed abort: ${String(ctx.signal.reason)}`);
  },
);

const fixtureCommand: CliContribution = {
  name: 'signal-fixture',
  description: 'Fixture command of the signal-handling E2E tests',
  canProvideBus: true,
  subcommands: [holdCommand],
  provideBus: (context) => bootEmbeddedWorkflowRuntime(context, { discovery: createSignalFixtureDiscovery() }),
  beforeRun: () => ALWAYS_PROCEED,
};

holdBootIfRequested();

await main(['node', 'command-signal-entry.ts', 'signal-fixture', 'hold'], [fixtureCommand]);
