/**
 * Handler for `makaio client wiring`.
 *
 * Dispatches `client.wiring.list` to the global aggregator, which fans out to
 * all enabled clients and returns their wiring entries with installation status.
 *
 * When `--client` is supplied, only that client's entries are shown. When
 * omitted, all enabled clients are listed.
 *
 * **Invariants:**
 * - Output is a human-readable table of entries grouped by client.
 * - The wiring request forwards the resolved Makaio command so displayed
 *   command strings match the command that `wire` would install.
 * - On bus failure, writes a diagnostic message and sets exit code 1.
 * - Never reads config files directly — all I/O is delegated to the per-client
 *   service via the bus.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import type { CommandContext } from '@makaio/kernel/cli';

// ---------------------------------------------------------------------------
// Public args shape
// ---------------------------------------------------------------------------

/**
 * Parsed CLI argument shape for the `client wiring` subcommand.
 */
export interface ClientWiringArgs {
  /**
   * Optional stable client identifier to filter results.
   *
   * When absent, all enabled clients are listed.
   */
  readonly client?: string;
  /**
   * Optional absolute path to the project directory.
   *
   * When supplied, per-client handlers include project- or local-scope entries
   * in their response in addition to the user/global scope.
   */
  readonly projectDir?: string;
}

// ---------------------------------------------------------------------------
// Narrow context interface (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Narrow command context used by {@link runClientWiringCommand}.
 *
 * Extracting the minimal surface area makes the handler fully testable
 * without constructing a real {@link CommandContext}.
 */
export interface ClientWiringCommandContext {
  /** Parsed CLI arguments. */
  readonly args: ClientWiringArgs;
  /** Bus façade used to dispatch the global wiring list request. */
  readonly bus: Pick<IMakaioBus, 'request'>;
  /** Output channel for writing results or errors. */
  readonly output: {
    /** Write to standard output. */
    write(text: string): void;
    /** Write to standard error. */
    error(text: string): void;
  };
  /**
   * Signal a non-zero exit code for the CLI invocation.
   * @param code - Exit code to set.
   */
  setExitCode(code: number): void;
}

// ---------------------------------------------------------------------------
// Injectable side-effects
// ---------------------------------------------------------------------------

/**
 * Side-effects bundle injected into {@link runClientWiringCommand}.
 */
export interface ClientWiringCommandDependencies {
  /**
   * Resolve the Makaio shell command to display in wiring entries.
   * @returns The Makaio executable path or command string.
   */
  readonly resolveMakaioCommand: () => string;
}

const defaultDependencies: ClientWiringCommandDependencies = {
  resolveMakaioCommand: () => process.argv[1] ?? 'makaio',
};

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * CLI entry handler for `makaio client wiring`.
 *
 * Delegates to {@link runClientWiringCommand} with the real bus context.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleClientWiring(ctx: CommandContext<ClientWiringArgs>): Promise<void> {
  await runClientWiringCommand(ctx, defaultDependencies);
}

/**
 * Execute the client wiring command.
 *
 * Requests the global wiring list and formats the response as a grouped
 * table. When no client responds, prints a short "no wiring entries" message.
 * On bus failure, writes a diagnostic message and sets exit code 1.
 * @param ctx - Narrow command context (args + bus + output + setExitCode).
 * @param deps - Injectable side-effects; defaults to process-level resolution.
 */
export async function runClientWiringCommand(
  ctx: ClientWiringCommandContext,
  deps: ClientWiringCommandDependencies = defaultDependencies,
): Promise<void> {
  const { client: clientId, projectDir } = ctx.args;
  const makaioCommand = deps.resolveMakaioCommand();

  try {
    const result = await ctx.bus.request(ClientSubjects.wiring.list, {
      clientId,
      projectDir,
      makaioCommand,
    });

    if (result.results.length === 0) {
      const scope = clientId !== undefined ? `client '${clientId}'` : 'any enabled client';
      ctx.output.write(`No wiring entries found for ${scope}.\n`);
      return;
    }

    for (const clientResult of result.results) {
      ctx.output.write(`\n${clientResult.clientId}:\n`);
      for (const entry of clientResult.entries) {
        const status = entry.installed ? 'installed' : 'missing  ';
        ctx.output.write(`  [${status}] ${entry.group}/${entry.name}  ${entry.command}\n`);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.output.error(`Failed to retrieve wiring status. Is the Makaio runtime running? Reason: ${reason}\n`);
    ctx.setExitCode(1);
  }
}
