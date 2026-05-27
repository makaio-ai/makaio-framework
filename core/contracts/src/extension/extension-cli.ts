import type { MakaioBusLike } from '@makaio/core';
import type { CliManifest } from './manifest.js';

/**
 * Type-erased output channel used by extension-local CLI handlers.
 *
 * Runtime code exposes the fully typed helper API via `@makaio/kernel/cli`.
 */
export interface ExtensionCliOutputWriter {
  /** Write text to standard output. */
  write(text: string): void;
  /** Write text to standard error. */
  error(text: string): void;
}

/**
 * Type-erased handler context stored in the contracts layer.
 *
 * Runtime code provides the fully typed variant in `@makaio/kernel/cli`.
 */
export interface ExtensionCliHandlerContext<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Parsed and validated command arguments/options. */
  readonly args: unknown;
  /**
   * Bus client connected to the running Makaio instance.
   *
   * `null` when the bus is unavailable and the contribution's `beforeRun`
   * hook opted into offline execution.
   */
  readonly bus: TBus | null;
  /** Output channel for writing to stdout and stderr. */
  readonly output: ExtensionCliOutputWriter;
  /** Abort signal triggered when the invocation is cancelled. */
  readonly signal: AbortSignal;
  /**
   * Set the process-style exit code for the current command invocation.
   * @param exitCode - Command exit code to report.
   */
  setExitCode(exitCode: number): void;
}

/**
 * Interactive entry context stored in the contracts layer.
 */
export interface ExtensionCliInteractiveContext<TBus extends MakaioBusLike = MakaioBusLike> {
  /**
   * Bus client connected to the running Makaio instance.
   *
   * `null` when the bus is unavailable and the contribution's `beforeRun`
   * hook opted into bus-optional execution.
   */
  readonly bus: TBus | null;
  /** Abort signal triggered when the interactive invocation is cancelled. */
  readonly signal: AbortSignal;
}

/**
 * Type-erased CLI subcommand entry for collection storage.
 *
 * See `@makaio/kernel/cli` for the full typed API including
 * `defineCliSubcommand`.
 */
export interface ExtensionCliSubcommandEntry<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Subcommand name. */
  readonly name: string;
  /** One-line description shown in help text. */
  readonly description: string;
  /** Minimal parse-only schema contract kept free of runtime Zod APIs. */
  readonly schema: { parse(v: unknown): unknown };
  /** Handler invoked with the type-erased CLI execution context. */
  readonly handler: (ctx: ExtensionCliHandlerContext<TBus>) => Promise<void>;
}

/**
 * Type-erased context for the {@link ExtensionCliContribution.beforeRun} gate.
 */
export interface ExtensionCliBeforeRunContext<TBus extends MakaioBusLike = MakaioBusLike> {
  /** Subcommand name, or `'__interactive__'` for bare interactive invocations. */
  readonly subcommandName: string;
  /** Parsed and validated arguments for the subcommand. */
  readonly args: Record<string, unknown>;
  /** Bus client, or `null` when the server is unreachable. */
  readonly bus: TBus | null;
}

/**
 * Type-erased result of an {@link ExtensionCliContribution.beforeRun} gate.
 */
export type ExtensionCliBeforeRunResult =
  | { readonly proceed: true }
  | { readonly proceed: false; readonly message: string; readonly exitCode?: number };

/**
 * An extension's CLI contribution declared in its `MakaioExtension` manifest.
 *
 * Full implementation types live in `@makaio/kernel/cli`. This contract
 * keeps the extension layer on the executable shape only.
 */
export interface ExtensionCliContribution<TBus extends MakaioBusLike = MakaioBusLike> extends CliManifest {
  /**
   * Interactive TUI launched when the command is invoked without a subcommand.
   */
  readonly interactive?: (ctx: ExtensionCliInteractiveContext<TBus>) => Promise<void>;
  /** Declared subcommands exposed by this contribution. */
  readonly subcommands: ReadonlyArray<ExtensionCliSubcommandEntry<TBus>>;
  /**
   * Pre-execution gate that replaces the default bus-required check.
   * @param context - Subcommand name, parsed args, and bus availability.
   * @returns Whether to proceed or block with a message.
   */
  readonly beforeRun?: (
    context: ExtensionCliBeforeRunContext<TBus>,
  ) => ExtensionCliBeforeRunResult | Promise<ExtensionCliBeforeRunResult>;
}
