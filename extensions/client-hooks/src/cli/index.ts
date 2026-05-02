/**
 * CLI contribution for the client-hooks package.
 *
 * Registers `makaio hook received <client> <event-name>`
 * — a generic, dumb bridge that reads JSON from stdin and emits it verbatim on
 * the raw catch-all subject for the specified client family
 * (`client:<clientId>.hook.received`).
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
import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
import { handleClientHook } from './client-hook-command.js';

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

/**
 * Client hooks CLI contribution.
 *
 * Registers `makaio hook` with a single `received` subcommand that acts as a
 * dumb stdin-to-bus bridge for any client's hook events.
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
  ],
};

export default clientHooksCli;
