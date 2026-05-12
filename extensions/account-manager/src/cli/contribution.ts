/**
 * CLI contribution for the account-manager package.
 *
 * Registers the `account-manager` top-level command with its subcommands and
 * interactive TUI entry point. The schemas declare both type shapes and CLI
 * metadata (descriptions, short flags, positional arguments) via Zod `.meta()`.
 */
import { z } from 'zod';
import { defineCliSubcommand, requireBus, type CliContribution } from '@makaio/kernel/cli';
import { handleList, handleSwitch, handleLabel, handleRemove, handleSources } from './handlers.js';
import { handleWatch } from './handlers/watch.js';

const listSchema = z.object({
  clientId: z.string().optional().meta({ description: 'Filter by client', short: '-c' }),
  format: z.enum(['table', 'json']).default('table').meta({ description: 'Output format', short: '-f' }),
});

const switchSchema = z.object({
  accountId: z.string().meta({ description: 'Account to activate', positional: true, placeholder: '<id>' }),
  clientId: z.string().optional().meta({ description: 'Client (inferred if unambiguous)', short: '-c' }),
});

const labelSchema = z.object({
  accountId: z.string().meta({ description: 'Account to label', positional: true, placeholder: '<id>' }),
  label: z.string().meta({ description: 'New label', positional: true, placeholder: '<label>' }),
  clientId: z.string().optional().meta({ description: 'Client (inferred if unambiguous)', short: '-c' }),
});

const removeSchema = z.object({
  accountId: z.string().meta({ description: 'Account to remove', positional: true, placeholder: '<id>' }),
  clientId: z.string().optional().meta({ description: 'Client (inferred if unambiguous)', short: '-c' }),
});

const watchSchema = z.object({});

/**
 * Account manager CLI contribution.
 *
 * Registers `makaio account-manager` with its subcommands and an interactive
 * Ink TUI that is lazy-loaded to avoid pulling in React for non-interactive
 * invocations.
 */
export const accountManagerCli: CliContribution = {
  name: 'account-manager',
  description: 'Manage AI tool credentials',

  interactive: async (ctx) => {
    const bus = requireBus(ctx);
    const { renderApp } = await import('./interactive.js');
    await renderApp(bus);
  },

  subcommands: [
    defineCliSubcommand('list', 'List configured accounts', listSchema, handleList),
    defineCliSubcommand('switch', 'Switch active account', switchSchema, handleSwitch),
    defineCliSubcommand('label', 'Set account label', labelSchema, handleLabel),
    defineCliSubcommand('remove', 'Remove an account', removeSchema, handleRemove),
    defineCliSubcommand('sources', 'Show detected credential sources', z.object({}), handleSources),
    defineCliSubcommand('watch', 'Stream account and usage events as NDJSON', watchSchema, handleWatch),
  ],
};
