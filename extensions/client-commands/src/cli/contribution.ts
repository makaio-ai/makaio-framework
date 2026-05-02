/**
 * CLI contribution for the client-commands package.
 *
 * Registers `makaio client wire <client> <scope>`,
 * `makaio client unwire <client> <scope>`, and
 * `makaio client wiring` subcommands.
 *
 * **Wire** installs Makaio hooks into the specified client's native config via
 * `client:<id>.wiring.apply`. **Unwire** removes them via
 * `client:<id>.wiring.remove`. **Wiring** queries the global
 * `client.wiring.list` aggregator and prints a grouped table of all wiring
 * entries with their installation status.
 * @packageDocumentation
 */

import { z } from 'zod';
import { AbsolutePathSchema } from '@makaio/clients-core';
import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
import { handleClientWire, type ClientWireArgs } from './wire-handler.js';
import { handleClientUnwire, type ClientUnwireArgs } from './unwire-handler.js';
import { handleClientWiring, type ClientWiringArgs } from './wiring-handler.js';

// ---------------------------------------------------------------------------
// Schemas
// Wire and unwire share client/scope/projectDir but differ enough (scope is
// required-positional vs absent, client is required vs optional) that a shared
// fragment would add indirection without meaningful drift prevention.
// ---------------------------------------------------------------------------

const wireSchema = z.object({
  client: z.string().meta({
    description: 'Client identifier (e.g. claude-code, codex)',
    positional: true,
    placeholder: '<client>',
  }),
  scope: z.string().meta({
    description: 'Scope at which to install hooks (client-specific, e.g. user, global)',
    positional: true,
    placeholder: '<scope>',
  }),
  projectDir: AbsolutePathSchema.optional().meta({
    description: 'Absolute path to the project directory (required for project/local scopes)',
    short: '-d',
    placeholder: '<path>',
  }),
}) satisfies z.ZodType<ClientWireArgs>;

const unwireSchema = z.object({
  client: z.string().meta({
    description: 'Client identifier (e.g. claude-code, codex)',
    positional: true,
    placeholder: '<client>',
  }),
  scope: z.string().meta({
    description: 'Scope from which to remove hooks (client-specific, e.g. user, global)',
    positional: true,
    placeholder: '<scope>',
  }),
  projectDir: AbsolutePathSchema.optional().meta({
    description: 'Absolute path to the project directory (required for project/local scopes)',
    short: '-d',
    placeholder: '<path>',
  }),
}) satisfies z.ZodType<ClientUnwireArgs>;

const wiringSchema = z.object({
  client: z.string().optional().meta({
    description: 'Optional client identifier to filter results',
    short: '-c',
    placeholder: '<client>',
  }),
  projectDir: AbsolutePathSchema.optional().meta({
    description: 'Absolute path to the project directory for scope-aware wiring status',
    short: '-d',
    placeholder: '<path>',
  }),
}) satisfies z.ZodType<ClientWiringArgs>;

// ---------------------------------------------------------------------------
// CLI contribution
// ---------------------------------------------------------------------------

/**
 * Client commands CLI contribution.
 *
 * Registers `makaio client` with three subcommands: `wire`, `unwire`, and
 * `wiring`.
 */
export const clientCommandsCli: CliContribution = {
  // Must match descriptor.json "name" — the extension loader validates
  // `contribution.name === descriptor.name`. The user-facing CLI
  // root command is declared separately in descriptor.json "cli.name".
  name: 'client-commands',
  description: 'Manage AI client integrations',
  subcommands: [
    defineCliSubcommand('wire', "Install Makaio hooks into a client's native config", wireSchema, handleClientWire),
    defineCliSubcommand(
      'unwire',
      "Remove Makaio hooks from a client's native config",
      unwireSchema,
      handleClientUnwire,
    ),
    defineCliSubcommand(
      'wiring',
      'Show hook wiring status for all or a specific client',
      wiringSchema,
      handleClientWiring,
    ),
  ],
};
