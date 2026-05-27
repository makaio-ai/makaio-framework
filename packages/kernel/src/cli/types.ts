/**
 * CLI command contract types.
 *
 * Plugins declare CLI commands using these types. The actual CLI framework
 * (commander, optique, etc.) is an implementation detail of `@makaio/cli` —
 * extensions never import it. Command options and arguments are defined as Zod
 * schemas with `.meta()` for CLI-specific metadata (description, short flags).
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
 *
 * const listSchema = z.object({
 *   profile: z.string().optional().meta({ description: 'Filter by profile', short: '-p' }),
 *   format: z.enum(['table', 'json']).default('table').meta({ description: 'Output format', short: '-f' }),
 * });
 *
 * export const cli: CliContribution = {
 *   name: 'account-manager',
 *   description: 'Manage AI tool credentials',
 *   interactive: async (ctx) => {
 *     const bus = requireBus(ctx);
 *     // Ink TUI — launched by bare `makaio account-manager`
 *   },
 *   subcommands: [
 *     defineCliSubcommand('list', 'List configured credentials', listSchema, async (ctx) => {
 *       // ctx.args.profile → string | undefined
 *       // ctx.args.format  → 'table' | 'json'
 *       // ctx.bus           → IMakaioBus | null
 *       // ctx.output        → OutputWriter
 *       // ctx.setExitCode() → signal a non-zero command result
 *     }),
 *   ],
 * };
 * ```
 * @see {@link https://zod.dev/metadata | Zod Metadata} for `.meta()` usage.
 */
import type { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CliManifest } from '@makaio/contracts/extension';

// ---------------------------------------------------------------------------
// Zod GlobalMeta augmentation — CLI-specific metadata fields
// ---------------------------------------------------------------------------

declare module 'zod' {
  interface GlobalMeta {
    /** Short flag alias for CLI options (e.g. `'-p'`, `'-f'`). */
    short?: string;
    /** Placeholder shown in help text (e.g. `'<name>'`, `'<path>'`). */
    placeholder?: string;
    /** When `true`, treat this field as a positional argument instead of a named option. */
    positional?: boolean;
  }
}

// ---------------------------------------------------------------------------
// Output writer — injectable output channel for CLI handlers
// ---------------------------------------------------------------------------

/**
 * Injectable output channel for CLI command handlers.
 *
 * Handlers write to `ctx.output` instead of `process.stdout`/`process.stderr`
 * directly. This enables output capture for remote execution via `cli.execute`
 * and test assertions.
 */
export interface OutputWriter {
  /** Write to standard output. */
  write(text: string): void;
  /** Write to standard error. */
  error(text: string): void;
}

// ---------------------------------------------------------------------------
// Command context — passed to every CLI handler
// ---------------------------------------------------------------------------

/**
 * Execution context provided to CLI command handlers.
 * @typeParam TArgs - Inferred from the command's Zod schema via `z.infer<T>`.
 */
export interface CommandContext<TArgs> {
  /** Parsed and validated command arguments/options. */
  readonly args: TArgs;
  /**
   * Bus client connected to the running Makaio instance.
   *
   * `null` when the bus is unavailable and the command opted into offline
   * execution via {@link CliContribution.beforeRun}. Handlers that declared
   * themselves runnable without the bus must check for `null` before making
   * bus calls.
   */
  readonly bus: IMakaioBus | null;
  /** Output channel for writing to stdout/stderr. */
  readonly output: OutputWriter;
  /**
   * Abort signal that is triggered when local CLI execution receives SIGINT,
   * SIGTERM, or SIGHUP.
   *
   * Commands must honour this signal before starting new work and during
   * long-running operations. The local CLI translates process signals into this
   * signal so command-owned `finally` blocks can dispose embedded runtimes
   * before the process exits with the conventional signal exit code.
   *
   * Always present — contexts that cannot supply a meaningful signal must use
   * `AbortSignal.timeout(Infinity)` or a never-aborting controller signal.
   */
  readonly signal: AbortSignal;
  /**
   * Set the process-style exit code for the current command invocation.
   *
   * Local CLI execution forwards this to `process.exitCode`. Remote execution
   * buffers it into the `cli.execute` RPC response instead of mutating the
   * server process.
   * @param exitCode - Command exit code to report.
   */
  setExitCode(exitCode: number): void;
}

// ---------------------------------------------------------------------------
// beforeRun — pre-execution gate for CLI contributions
// ---------------------------------------------------------------------------

/**
 * Context provided to {@link CliContribution.beforeRun} for pre-execution
 * gating decisions.
 */
export interface BeforeRunContext {
  /**
   * Name of the subcommand being invoked (e.g. `'list'`, `'statusline'`).
   *
   * Set to {@link INTERACTIVE_SUBCOMMAND} (`'__interactive__'`) when the bare
   * interactive invocation is dispatched.
   */
  readonly subcommandName: string;
  /** Parsed and validated arguments for the subcommand. */
  readonly args: Record<string, unknown>;
  /**
   * Bus client, or `null` when the server is unreachable.
   *
   * Extensions that can operate without the bus inspect this to decide
   * whether to proceed. Extensions that need a license check can use
   * the bus (when available) to query license state.
   */
  readonly bus: IMakaioBus | null;
}

/**
 * Result of a {@link CliContribution.beforeRun} gate check.
 *
 * - `{ proceed: true }` — skip the default bus-required gate and run the
 *   handler. The handler receives `bus: IMakaioBus | null`.
 * - `{ proceed: false, message, exitCode? }` — block execution and display
 *   the message. Defaults to exit code 1.
 */
export type BeforeRunResult =
  | { readonly proceed: true }
  | { readonly proceed: false; readonly message: string; readonly exitCode?: number };

// ---------------------------------------------------------------------------
// Subcommand definition — schema + handler, fully typed
// ---------------------------------------------------------------------------

/**
 * A single CLI subcommand with a Zod schema and strongly-typed handler.
 *
 * The schema defines both the data shape (for type inference) and CLI metadata
 * (descriptions, short flags) via Zod's `.meta()` on each field.
 * @typeParam T - A `z.ZodObject` whose shape defines the command's options/args.
 */
export interface CliSubcommandDefinition<T extends z.ZodObject<z.ZodRawShape>> {
  /** Subcommand name (e.g. `'list'`, `'switch'`). */
  readonly name: string;
  /** One-line description shown in help text. */
  readonly description: string;
  /** Zod object schema defining the command's options and arguments. */
  readonly schema: T;
  /** Handler invoked with the parsed, validated context. */
  readonly handler: (ctx: CommandContext<z.infer<T>>) => Promise<void>;
}

/**
 * Type-erased subcommand definition for collections.
 *
 * When collecting subcommands into arrays or registries, the per-schema generic
 * is erased. The handler contract is preserved at runtime via the closure
 * created by {@link defineCliSubcommand}.
 */
export interface CliSubcommandEntry {
  /** Subcommand name. */
  readonly name: string;
  /** One-line description. */
  readonly description: string;
  /** Zod object schema (type-erased for collection storage). */
  readonly schema: z.ZodObject<z.ZodRawShape>;
  /** Handler that receives a {@link CommandContext} with the schema's inferred type. */
  readonly handler: (ctx: CommandContext<unknown>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sentinel subcommand name passed to {@link CliContribution.beforeRun} when
 * the bare interactive invocation (`makaio <name>`) is dispatched.
 */
export const INTERACTIVE_SUBCOMMAND = '__interactive__' as const;

/**
 * Convenience {@link BeforeRunResult} for extensions that always proceed.
 *
 * Use this as the return value from {@link CliContribution.beforeRun} when
 * the extension unconditionally opts into bus-optional execution.
 */
export const ALWAYS_PROCEED: BeforeRunResult = { proceed: true } as const;

// ---------------------------------------------------------------------------
// Interactive command context
// ---------------------------------------------------------------------------

/**
 * Execution context provided to bare interactive CLI handlers.
 */
export interface InteractiveCommandContext {
  /**
   * Bus client connected to the running Makaio instance.
   *
   * `null` when the bus is unavailable and the contribution's `beforeRun`
   * hook opted into bus-optional execution.
   */
  readonly bus: IMakaioBus | null;
  /**
   * Abort signal triggered when local CLI execution receives SIGINT, SIGTERM,
   * or SIGHUP.
   *
   * Interactive handlers must observe this signal and tear down any TUI
   * renderer they own, because local CLI signal handling defers immediate
   * process termination until command-owned cleanup has run.
   */
  readonly signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Bus provisioning — embedded bus lifecycle for standalone execution
// ---------------------------------------------------------------------------

/**
 * Context passed to {@link CliContribution.provideBus} so the extension can
 * inspect the incoming invocation before deciding whether to bootstrap a bus.
 */
export interface ProvideBusContext {
  /**
   * Name of the subcommand being invoked (e.g. `'run'`, `'start'`).
   *
   * Set to {@link INTERACTIVE_SUBCOMMAND} (`'__interactive__'`) when the bare
   * interactive invocation is dispatched.
   */
  readonly subcommandName: string;
  /** Parsed and validated arguments for the subcommand. */
  readonly args: Record<string, unknown>;
  /** Absolute path of the working directory from which the CLI was invoked. */
  readonly cwd: string;
}

/**
 * Handle returned by {@link CliContribution.provideBus} when the extension
 * successfully bootstraps an embedded bus.
 *
 * The CLI router holds this handle for the duration of the command invocation
 * and calls `dispose` during teardown to shut down the embedded bus cleanly.
 */
export interface EmbeddedBusHandle {
  /** The live bus instance to inject into command handlers. */
  readonly bus: IMakaioBus;
  /**
   * Shut down the embedded bus and release all associated resources.
   *
   * Called by the CLI router after the command handler completes (or errors).
   * Implementations must be idempotent — calling `dispose` more than once must
   * not throw.
   * @returns A promise that resolves when teardown is complete.
   */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Top-level CLI contribution — what extensions export
// ---------------------------------------------------------------------------

/**
 * A plugin's CLI contribution, declared in its `MakaioExtension` manifest.
 *
 * Extends {@link CliManifest} (pure-data) with executable code: an optional
 * interactive TUI handler and typed subcommand definitions. The CLI router
 * uses {@link CliManifest} for discovery and help generation; this type is
 * used when the package is loaded and ready to handle commands.
 *
 * The CLI router dispatches as follows:
 * - `makaio account-manager`        → {@link interactive} (if defined)
 * - `makaio account-manager --help` → auto-generated from subcommands + schema metadata
 * - `makaio account-manager list`   → matched subcommand handler
 *
 * Bus resolution order (first match wins):
 * 1. External daemon connection — if the server is reachable, its bus is used.
 * 2. {@link provideBus} — extension embeds its own bus (standalone mode).
 * 3. `null` bus — passed to handlers only when {@link beforeRun} opts in.
 *
 * {@link beforeRun} is evaluated **after** bus resolution completes so that its
 * context always reflects the final resolved bus state.
 */
export interface CliContribution extends CliManifest {
  /**
   * Interactive TUI launched when the command is invoked without a subcommand.
   *
   * When defined, bare `makaio <name>` enters this handler instead of printing
   * help. Typically renders an Ink TUI that reuses the same bus RPC calls as
   * the non-interactive subcommands.
   *
   * The bus is non-null when no {@link beforeRun} hook is defined (the default
   * gate ensures a connected bus). When `beforeRun` opts into bus-optional
   * execution, `bus` may be `null` — use {@link requireBus} at the top of the
   * handler if the TUI needs bus RPC calls.
   */
  readonly interactive?: (ctx: InteractiveCommandContext) => Promise<void>;
  /** Typed subcommand definitions with Zod schemas and strongly-typed handlers. */
  readonly subcommands: ReadonlyArray<CliSubcommandEntry>;
  /**
   * Pre-execution gate evaluated **after** bus resolution (including any
   * embedded bus from {@link provideBus}) completes.
   *
   * When provided, this hook **replaces** the default "bus must be connected"
   * gate. The extension inspects the context (including bus availability) and
   * decides whether execution should proceed.
   *
   * Use cases:
   * - **Bus-optional commands** — extensions that can operate without the
   *   server (e.g. `claude-code-statusline`, fire-and-forget hooks).
   * - **License gates** — paid extensions that need to verify a subscription
   *   before allowing execution.
   *
   * When absent, the CLI framework applies the default behavior: require a
   * connected bus and fail with a connection error when unavailable.
   * @param context - Subcommand name, parsed args, and bus availability.
   * @returns Whether to proceed or block with a message.
   */
  readonly beforeRun?: (context: BeforeRunContext) => BeforeRunResult | Promise<BeforeRunResult>;
  /**
   * Bootstrap an embedded bus for standalone or in-process execution.
   *
   * When defined and {@link CliManifest.canProvideBus} is `true` in the
   * manifest, the CLI router calls this hook **only when no external daemon
   * connection was established**. If it returns a non-null handle the embedded
   * bus is used for the lifetime of the command; the router calls
   * {@link EmbeddedBusHandle.dispose} after the handler completes.
   *
   * Returning `null` signals that this invocation should not use an embedded
   * bus and the handler receives `bus: null`.
   * @param context - Subcommand name, parsed args, and working directory.
   * @returns A live bus handle, or `null` to fall through to normal connection.
   */
  readonly provideBus?: (context: ProvideBusContext) => Promise<EmbeddedBusHandle | null>;
}

// ---------------------------------------------------------------------------
// Bus narrowing — runtime assertion for bus-required handlers
// ---------------------------------------------------------------------------

/**
 * Assert that the bus is available and narrow the type to non-null.
 *
 * Handlers that require the bus (i.e. extensions without a `beforeRun` hook
 * that permits offline execution) call this at the top of their handler to
 * get a typed non-null bus reference. Throws if the bus is unexpectedly null
 * — which should not happen when the default bus-required gate is active.
 *
 * Works with both subcommand {@link CommandContext} and interactive handler
 * contexts — any object with a `bus` property satisfies the signature.
 * @param ctx - Context containing a potentially null bus reference.
 * @returns The non-null bus instance.
 */
export function requireBus(ctx: { readonly bus: IMakaioBus | null }): IMakaioBus {
  if (!ctx.bus) {
    throw new Error('This command requires a running Makaio server.');
  }
  return ctx.bus;
}

// ---------------------------------------------------------------------------
// Builder — identity function for type inference
// ---------------------------------------------------------------------------

/**
 * Define a CLI subcommand with full type inference from schema to handler.
 *
 * This is an identity function whose only purpose is to create a scope where
 * TypeScript infers `T` from `schema` and flows it into `handler`. No runtime
 * cost. Same pattern as Vite's `defineConfig()` or Vue's `defineComponent()`.
 * @param name - Subcommand name.
 * @param description - One-line description for help text.
 * @param schema - Zod object schema defining options/arguments.
 * @param handler - Async handler receiving the typed {@link CommandContext}.
 * @returns A {@link CliSubcommandEntry} suitable for inclusion in a {@link CliContribution}.
 */
export function defineCliSubcommand<T extends z.ZodObject<z.ZodRawShape>>(
  name: string,
  description: string,
  schema: T,
  handler: (ctx: CommandContext<z.infer<T>>) => Promise<void>,
): CliSubcommandEntry {
  return {
    name,
    description,
    schema,
    handler: handler as (ctx: CommandContext<unknown>) => Promise<void>,
  };
}
