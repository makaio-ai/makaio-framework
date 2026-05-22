/**
 * CLI contribution for the client-commands package.
 *
 * Registers `makaio client wire <client> <scope>`,
 * `makaio client unwire <client> <scope>`, and
 * `makaio client wiring` subcommands, as well as the profile management
 * subcommands: `profile-list`, `profile-create`, `profile-delete`,
 * `profile-default`, `profile-show`, and `profile-open`.
 *
 * **Wire** installs Makaio hooks into the specified client's native config via
 * `client:<id>.wiring.apply`. **Unwire** removes them via
 * `client:<id>.wiring.remove`. **Wiring** queries the global
 * `client.wiring.list` aggregator and prints a grouped table of all wiring
 * entries with their installation status.
 *
 * The **profile-*** subcommands manage named configuration profiles for a
 * client via the `client.profile.*` bus subjects.
 * @packageDocumentation
 */

import { z } from 'zod';
import { AbsolutePathSchema } from '@makaio/subsystem-client';
import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
import { handleClientWire, type ClientWireArgs } from './wire-handler.js';
import { handleClientUnwire, type ClientUnwireArgs } from './unwire-handler.js';
import { handleClientWiring, type ClientWiringArgs } from './wiring-handler.js';
import {
  handleProfileList,
  handleProfileCreate,
  handleProfileDelete,
  handleProfileDefault,
  handleProfileShow,
  handleProfileOpen,
  type ProfileListArgs,
  type ProfileCreateArgs,
  type ProfileDeleteArgs,
  type ProfileDefaultArgs,
  type ProfileShowArgs,
  type ProfileOpenArgs,
} from './profile-handler.js';

// ---------------------------------------------------------------------------
// Schemas
// Wire and unwire share client/scope/projectDir but differ enough (scope is
// required-positional vs absent, client is required vs optional) that a shared
// fragment would add indirection without meaningful drift prevention.
// ---------------------------------------------------------------------------

export const wireSchema = z.object({
  client: z.string().meta({
    description: 'Client identifier (e.g. claude-code, codex)',
    positional: true,
    placeholder: '<client>',
  }),
  scope: z.string().default('user').meta({
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

const profileListSchema = z.object({
  client: z.string().meta({
    description: 'Client identifier (e.g. claude-code)',
    positional: true,
    placeholder: '<client>',
  }),
}) satisfies z.ZodType<ProfileListArgs>;

const profileCreateSchema = z.object({
  client: z.string().meta({
    description: 'Client identifier (e.g. claude-code)',
    positional: true,
    placeholder: '<client>',
  }),
  name: z.string().meta({
    description: 'Profile name',
    positional: true,
    placeholder: '<name>',
  }),
  description: z.string().optional().meta({
    description: 'Profile description',
    short: '-d',
    placeholder: '<desc>',
  }),
}) satisfies z.ZodType<ProfileCreateArgs>;

const profileDeleteSchema = z.object({
  client: z.string().meta({
    description: 'Client identifier (e.g. claude-code)',
    positional: true,
    placeholder: '<client>',
  }),
  name: z.string().meta({
    description: 'Profile name',
    positional: true,
    placeholder: '<name>',
  }),
}) satisfies z.ZodType<ProfileDeleteArgs>;

const profileDefaultSchema = z.object({
  client: z.string().meta({
    description: 'Client identifier (e.g. claude-code)',
    positional: true,
    placeholder: '<client>',
  }),
  name: z.string().meta({
    description: 'Profile name',
    positional: true,
    placeholder: '<name>',
  }),
}) satisfies z.ZodType<ProfileDefaultArgs>;

const profileShowSchema = z.object({
  client: z.string().meta({
    description: 'Client identifier (e.g. claude-code)',
    positional: true,
    placeholder: '<client>',
  }),
  name: z.string().meta({
    description: 'Profile name',
    positional: true,
    placeholder: '<name>',
  }),
}) satisfies z.ZodType<ProfileShowArgs>;

const profileOpenSchema = z.object({
  client: z.string().meta({
    description: 'Client identifier (e.g. claude-code)',
    positional: true,
    placeholder: '<client>',
  }),
  name: z.string().meta({
    description: 'Profile name',
    positional: true,
    placeholder: '<name>',
  }),
}) satisfies z.ZodType<ProfileOpenArgs>;

// ---------------------------------------------------------------------------
// CLI contribution
// ---------------------------------------------------------------------------

/**
 * Client commands CLI contribution.
 *
 * Registers `makaio client` with subcommands for hook wiring (`wire`,
 * `unwire`, `wiring`) and profile management (`profile-list`,
 * `profile-create`, `profile-delete`, `profile-default`, `profile-show`,
 * `profile-open`).
 */
export const clientCommandsCli: CliContribution = {
  // Must match descriptor.json "cli.name"; the package identity remains
  // `client-commands`, but the user-facing root command is `makaio client`.
  name: 'client',
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
    defineCliSubcommand('profile-list', 'List all profiles for a client', profileListSchema, handleProfileList),
    defineCliSubcommand('profile-create', 'Create a new named profile', profileCreateSchema, handleProfileCreate),
    defineCliSubcommand(
      'profile-delete',
      'Delete a named profile and its config directory',
      profileDeleteSchema,
      handleProfileDelete,
    ),
    defineCliSubcommand(
      'profile-default',
      'Set the default profile for a client',
      profileDefaultSchema,
      handleProfileDefault,
    ),
    defineCliSubcommand('profile-show', 'Show details of a named profile', profileShowSchema, handleProfileShow),
    defineCliSubcommand(
      'profile-open',
      'Open a profile config directory in the file manager',
      profileOpenSchema,
      handleProfileOpen,
    ),
  ],
};
