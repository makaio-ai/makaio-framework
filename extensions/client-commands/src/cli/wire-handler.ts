/**
 * Handler for `makaio client wire <client> <scope>`.
 *
 * Dispatches a `client:<id>.wiring.apply` request to the named client's
 * service, which installs Makaio hooks into the client's native config at the
 * specified scope.
 *
 * **Invariants:**
 * - Fail fast: if the bus request fails (no handler, validation error, etc.),
 *   write an error message and set exit code 1.
 * - `makaioCommand` defaults to `process.argv[1]` so the installed hook
 *   command stays consistent with the binary that ran `wire`.
 * - Never reads or writes config files directly — all I/O is delegated to the
 *   per-client service via the bus.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { ClientWiringApplyResponse } from '@makaio/subsystem-client';
import { requireBus, type CommandContext } from '@makaio/kernel/cli';
import { createClientWiringApplySubjectDef } from '../subjects.js';

// ---------------------------------------------------------------------------
// Public args shape
// ---------------------------------------------------------------------------

/**
 * Parsed CLI argument shape for the `client wire` subcommand.
 */
export interface ClientWireArgs {
  /** Stable client identifier (e.g. `'claude-code'`, `'codex'`). */
  readonly client: string;
  /** Scope at which to install hooks (client-specific, e.g. `'user'`, `'global'`). */
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
 * Narrow command context used by {@link runClientWireCommand}.
 *
 * Extracting the minimal surface area makes the handler fully testable
 * without constructing a real {@link CommandContext}.
 */
export interface ClientWireCommandContext {
  /** Parsed CLI arguments. */
  readonly args: ClientWireArgs;
  /** Bus façade used to dispatch the apply request. */
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
 * Side-effects bundle injected into {@link runClientWireCommand}.
 *
 * Using a plain object interface keeps tests light — each test supplies only
 * the stubs it needs.
 */
export interface ClientWireCommandDependencies {
  /**
   * Resolve the Makaio shell command to embed in the installed hook.
   *
   * Defaults to `process.argv[1]` so the installed hook re-invokes the same
   * binary that ran `wire`.
   * @returns The Makaio executable path or command string.
   */
  readonly resolveMakaioCommand: () => string;
  /**
   * Resolve environment variable pairs to prepend before the executable in
   * every generated hook/statusline command.
   *
   * Returns `undefined` in production (binary is self-contained). In dev mode
   * returns `MAKAIO_CONFIG_FILE=...` and `MAKAIO_HOME=...` so the hook
   * subprocess discovers extensions and runtime state.
   * @returns Array of `KEY=value` strings, or `undefined`.
   */
  readonly resolveEnvPairs?: () => string[] | undefined;
}

/**
 * Resolve the default Makaio command from the current process argument vector.
 *
 * `argv[1]` must remain a single executable token because client wiring renders
 * it as the command prefix and shell-quotes it as one argument.  Development
 * TypeScript entrypoints are executable via their shebang, so they use the same
 * single-token path contract as compiled binaries.
 * @param argv - Process argument vector (defaults to `process.argv`).
 * @returns Executable command string for embedding in hook and statusline commands.
 */
export function resolveDefaultMakaioCommand(argv: readonly string[] = process.argv): string {
  const scriptPath = argv[1];
  if (scriptPath === undefined || scriptPath === '') {
    return 'makaio';
  }
  return scriptPath;
}

/**
 * Build env pairs from the current process environment when running in dev mode.
 *
 * Dev mode is detected by the presence of `MAKAIO_CONFIG_FILE` in the
 * environment. In production, the binary discovers its config via the default
 * `~/.makaio/` path and no env injection is needed.
 * @param env - Environment snapshot (defaults to `process.env`).
 * @returns Array of `KEY=value` strings, or `undefined` in production.
 */
export function resolveDefaultEnvPairs(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const configFile = env['MAKAIO_CONFIG_FILE'];
  if (!configFile) return undefined;

  const pairs: string[] = [`MAKAIO_CONFIG_FILE=${configFile}`];
  const home = env['MAKAIO_HOME'];
  if (home) {
    pairs.push(`MAKAIO_HOME=${home}`);
  }
  return pairs;
}

const defaultDependencies: ClientWireCommandDependencies = {
  resolveMakaioCommand: () => resolveDefaultMakaioCommand(),
  resolveEnvPairs: () => resolveDefaultEnvPairs(),
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * CLI entry handler for `makaio client wire <client> <scope>`.
 *
 * Delegates to {@link runClientWireCommand} with process-level defaults.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleClientWire(ctx: CommandContext<ClientWireArgs>): Promise<void> {
  await runClientWireCommand({ ...ctx, bus: requireBus(ctx) }, defaultDependencies);
}

/**
 * Execute the client wire command.
 *
 * Dispatches `client:<clientId>.wiring.apply` via the bus and reports the
 * number of hooks applied vs skipped. On failure (no handler, schema
 * validation, or transport error), writes a diagnostic message and sets
 * exit code 1.
 * @param ctx - Narrow command context (args + bus + output + setExitCode).
 * @param deps - Injectable side-effects; defaults to process-level resolution.
 */
export async function runClientWireCommand(
  ctx: ClientWireCommandContext,
  deps: ClientWireCommandDependencies = defaultDependencies,
): Promise<void> {
  const { client, scope, projectDir } = ctx.args;
  const makaioCommand = deps.resolveMakaioCommand();
  const envPairs = deps.resolveEnvPairs?.();
  const subject = createClientWiringApplySubjectDef(client);

  let result: ClientWiringApplyResponse;
  try {
    result = await ctx.bus.request(subject, {
      scope,
      projectDir,
      makaioCommand,
      envPairs,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.output.error(`Failed to wire ${client}. Is the client loaded and running? Scope: ${scope} Reason: ${reason}\n`);
    ctx.setExitCode(1);
    return;
  }

  ctx.output.write(`Wired ${client}: applied ${result.applied} hook(s), skipped ${result.skipped} already present.\n`);
}
