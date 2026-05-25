/**
 * Setup command registration.
 *
 * Registers the built-in `setup` command which runs the guided first-time setup
 * TUI. The Ink/React TUI is lazy-loaded only when the command action fires,
 * keeping those dependencies off the CLI startup path.
 *
 * UX shape:
 * ```
 * makaio setup   # Run guided first-time setup
 * ```
 *
 * The command requires an active bus connection. If the server is unreachable
 * the command fails immediately with a contextual error message.
 * @packageDocumentation
 */

import type { CommandInstance } from './command-tree.js';
import type { IMakaioBus } from '@makaio/bus-core';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Context required by the setup command.
 */
export interface SetupCommandContext {
  /** Bus instance for RPC communication, or null if not connected. */
  readonly bus: IMakaioBus | null;
  /** Absolute path to the makaio home directory. */
  readonly makaioHome: string;
}

/**
 * Registers the `setup` subcommand on the given Commander program.
 *
 * The TUI is lazy-loaded only when the command action runs,
 * keeping Ink/React out of the CLI startup path.
 * @param program - The root Commander program.
 * @param ctx - Setup command context (bus + makaioHome).
 */
export function registerSetupCommand(program: CommandInstance, ctx: SetupCommandContext): void {
  program
    .command('setup')
    .description('Run guided first-time setup')
    .action(async () => {
      if (ctx.bus === null) {
        console.error('Setup requires a running Makaio server. Start with: makaio serve');
        process.exitCode = 1;
        return;
      }

      // Lazy-load TUI to keep Ink/React out of CLI startup
      const { runSetupTui } = await import('./setup-tui/app.js');
      await runSetupTui({ bus: ctx.bus, makaioHome: ctx.makaioHome, repoPath: process.cwd() });
    });
}
