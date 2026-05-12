/**
 * Handler for `makaio client unwire <client> <scope>`.
 *
 * Dispatches a `client:<id>.wiring.remove` request to the named client's
 * service, which removes Makaio hooks from the client's native config at the
 * specified scope.
 *
 * **Invariants:**
 * - Fail fast: if the bus request fails (no handler, validation error, etc.),
 *   write an error message and set exit code 1.
 * - Never reads or writes config files directly — all I/O is delegated to the
 *   per-client service via the bus.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { ClientWiringRemoveResponse } from '@makaio/clients-core';
import { requireBus, type CommandContext } from '@makaio/kernel/cli';
import { createClientWiringRemoveSubjectDef } from '../subjects.js';

// ---------------------------------------------------------------------------
// Public args shape
// ---------------------------------------------------------------------------

/**
 * Parsed CLI argument shape for the `client unwire` subcommand.
 */
export interface ClientUnwireArgs {
  /** Stable client identifier (e.g. `'claude-code'`, `'codex'`). */
  readonly client: string;
  /** Scope from which to remove hooks (client-specific, e.g. `'user'`, `'global'`). */
  readonly scope: string;
  /**
   * Absolute path to the project directory.
   *
   * Required when the target scope is project- or local-scoped (client-specific
   * rules enforced by the per-client handler).
   */
  readonly projectDir?: string;
}

// ---------------------------------------------------------------------------
// Narrow context interface (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Narrow command context used by {@link runClientUnwireCommand}.
 *
 * Extracting the minimal surface area makes the handler fully testable
 * without constructing a real {@link CommandContext}.
 */
export interface ClientUnwireCommandContext {
  /** Parsed CLI arguments. */
  readonly args: ClientUnwireArgs;
  /** Bus façade used to dispatch the remove request. */
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
// Public entry point
// ---------------------------------------------------------------------------

/**
 * CLI entry handler for `makaio client unwire <client> <scope>`.
 *
 * Delegates to {@link runClientUnwireCommand} with the real bus context.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleClientUnwire(ctx: CommandContext<ClientUnwireArgs>): Promise<void> {
  await runClientUnwireCommand({ ...ctx, bus: requireBus(ctx) });
}

/**
 * Execute the client unwire command.
 *
 * Dispatches `client:<clientId>.wiring.remove` via the bus and reports the
 * number of hooks removed. On failure (no handler, schema validation, or
 * transport error), writes a diagnostic message and sets exit code 1.
 * @param ctx - Narrow command context (args + bus + output + setExitCode).
 */
export async function runClientUnwireCommand(ctx: ClientUnwireCommandContext): Promise<void> {
  const { client, scope, projectDir } = ctx.args;
  const subject = createClientWiringRemoveSubjectDef(client);

  let result: ClientWiringRemoveResponse;
  try {
    result = await ctx.bus.request(subject, { scope, projectDir });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.output.error(
      `Failed to unwire ${client}. Is the client loaded and running? Scope: ${scope} Reason: ${reason}\n`,
    );
    ctx.setExitCode(1);
    return;
  }

  ctx.output.write(`Unwired ${client}: removed ${result.removed} hook(s).\n`);
}
