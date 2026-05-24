/**
 * CLI contribution for the git-hooks extension.
 *
 * Registers `makaio git-hooks` with subcommands for installing, removing,
 * inspecting, and manually ingesting native Git hook events.
 * @packageDocumentation
 */

import { z } from 'zod';
import { ALWAYS_PROCEED, defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
import { handleGitHooksInstall } from './install-command.js';
import { handleGitHooksUninstall } from './uninstall-command.js';
import { handleGitHooksStatus } from './status-command.js';
import { handleGitHooksReceived } from './received-command.js';

const repoOption = z.object({
  repo: z.string().optional().meta({
    description: 'Repository root. Defaults to the current working directory.',
    short: '-r',
    placeholder: '<path>',
  }),
});

const installSchema = repoOption.extend({
  receiverCommand: z.string().optional().meta({
    description: 'Absolute receiver command to install in wrapper scripts.',
    placeholder: '<command>',
  }),
});

const uninstallSchema = repoOption;
const statusSchema = repoOption;

const receivedSchema = repoOption.extend({
  eventName: z.string().meta({
    description: 'Git hook event name, for manual testing only.',
    positional: true,
    placeholder: '<event-name>',
  }),
});

/**
 * Git hooks CLI contribution.
 *
 * Exposes `makaio git-hooks` with subcommands for managing native hook
 * installation in local Git repositories. All subcommands operate on the local
 * filesystem and do not require a running Makaio bus.
 */
export const gitHooksCli: CliContribution = {
  name: 'git-hooks',
  description: 'Install and inspect native Git hook integration',
  subcommands: [
    defineCliSubcommand('install', 'Install native Git hooks for a repository', installSchema, handleGitHooksInstall),
    defineCliSubcommand(
      'uninstall',
      'Remove native Git hooks from a repository',
      uninstallSchema,
      handleGitHooksUninstall,
    ),
    defineCliSubcommand('status', 'Show native Git hook status for a repository', statusSchema, handleGitHooksStatus),
    defineCliSubcommand('received', 'Manually ingest a raw Git hook event', receivedSchema, handleGitHooksReceived),
  ],
  beforeRun: () => ALWAYS_PROCEED,
};

export default gitHooksCli;
