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
 *   interactive: async ({ bus }) => {
 *     // Ink TUI — launched by bare `makaio account-manager`
 *   },
 *   subcommands: [
 *     defineCliSubcommand('list', 'List configured credentials', listSchema, async (ctx) => {
 *       // ctx.args.profile → string | undefined
 *       // ctx.args.format  → 'table' | 'json'
 *       // ctx.bus           → IMakaioBus
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
  /** Bus client connected to the running Makaio instance. */
  readonly bus: IMakaioBus;
  /** Output channel for writing to stdout/stderr. */
  readonly output: OutputWriter;
  /**
   * Abort signal that is triggered when the process receives SIGINT (Ctrl-C).
   *
   * Long-running commands (e.g. `watch`) should honour this signal to perform
   * clean teardown instead of relying on process termination. Short-lived
   * commands may ignore it.
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
 */
export interface CliContribution extends CliManifest {
  /**
   * Interactive TUI launched when the command is invoked without a subcommand.
   *
   * When defined, bare `makaio <name>` enters this handler instead of printing
   * help. Typically renders an Ink TUI that reuses the same bus RPC calls as
   * the non-interactive subcommands.
   */
  readonly interactive?: (ctx: { bus: IMakaioBus }) => Promise<void>;
  /** Typed subcommand definitions with Zod schemas and strongly-typed handlers. */
  readonly subcommands: ReadonlyArray<CliSubcommandEntry>;
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
