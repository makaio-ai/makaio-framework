/**
 * CLI contribution for the client-hooks package.
 *
 * Registers `makaio hook received <client> <event-name>` and
 * `makaio hook handle <client> <event-name>`.
 *
 * - `received` is a fire-and-forget bridge: it reads JSON from stdin and emits
 *   it verbatim on the raw catch-all subject for the specified client family
 *   (`client:<clientId>.hook.received`).
 * - `handle` extends `received` with a request/response round-trip on
 *   `client:<clientId>.hook.handle`, allowing a registered handler to write
 *   to stdout/stderr and control the process exit code.
 *
 * **Shape note:** The original design called for
 * `makaio <client> hook <event-name>` with a dynamic top-level command per
 * client. That shape is not possible because `CliContribution.name` must be a
 * static string known at registration time — the framework cannot register
 * positional or dynamic top-level command names at runtime. The
 * `hook received <client> <event-name>` shape satisfies the static-name
 * requirement while keeping `client` and `eventName` as regular positional
 * arguments to the subcommand.
 * @packageDocumentation
 */

import { z } from 'zod';
import { ALWAYS_PROCEED, defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
import { DEFAULT_HOOK_HANDLE_TIMEOUT_MS } from '@makaio/subsystem-client';
import { handleClientHook, handleClientHookHandle } from './client-hook-command.js';

const hookSchema = z.object({
  client: z.string().meta({
    description: 'Client identifier (e.g. codex, claude-code)',
    positional: true,
    placeholder: '<client>',
  }),
  eventName: z.string().meta({
    description: 'Hook event name as reported by the native client',
    positional: true,
    placeholder: '<event-name>',
  }),
  metadataJson: z.string().optional().meta({
    description: 'Optional JSON object for pass-through metadata (e.g. process PID)',
    placeholder: '<json>',
  }),
});

const hookHandleSchema = hookSchema.extend({
  timeout: z.number().int().positive().optional().default(DEFAULT_HOOK_HANDLE_TIMEOUT_MS).meta({
    description: 'Maximum wait time for a bus response in milliseconds',
    placeholder: '<ms>',
  }),
  failClose: z.boolean().optional().default(false).meta({
    description: 'On error or timeout: exit non-zero instead of failing open (default: exit 0)',
  }),
});

/**
 * Client hooks CLI contribution.
 *
 * Registers `makaio hook` with two subcommands:
 * - `received` — fire-and-forget stdin-to-bus bridge.
 * - `handle` — request/response bridge that translates the bus response into
 *   process stdout, stderr, and exit code.
 */
export const clientHooksCli: CliContribution = {
  name: 'hook',
  description: 'Bridge client hook events to the Makaio bus',
  subcommands: [
    defineCliSubcommand(
      'received',
      'Ingest a raw client hook event from stdin and emit it on the bus',
      hookSchema,
      handleClientHook,
    ),
    defineCliSubcommand(
      'handle',
      'Ingest a client hook event and return a handler response via stdout/stderr/exitCode',
      hookHandleSchema,
      handleClientHookHandle,
    ),
  ],
  beforeRun: () => ALWAYS_PROCEED,
};

export default clientHooksCli;
