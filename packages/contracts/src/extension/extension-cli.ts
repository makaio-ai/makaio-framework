import type { IMakaioBus } from '@makaio/bus-core';
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
export interface ExtensionCliHandlerContext {
  /** Parsed and validated command arguments/options. */
  readonly args: unknown;
  /** Bus client connected to the running Makaio instance. */
  readonly bus: IMakaioBus;
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
export interface ExtensionCliInteractiveContext {
  /** Bus client connected to the running Makaio instance. */
  readonly bus: IMakaioBus;
}

/**
 * Type-erased CLI subcommand entry for collection storage.
 *
 * See `@makaio/kernel/cli` for the full typed API including
 * `defineCliSubcommand`.
 */
export interface ExtensionCliSubcommandEntry {
  /** Subcommand name. */
  readonly name: string;
  /** One-line description shown in help text. */
  readonly description: string;
  /** Minimal parse-only schema contract kept free of runtime Zod APIs. */
  readonly schema: { parse(v: unknown): unknown };
  /** Handler invoked with the type-erased CLI execution context. */
  readonly handler: (ctx: ExtensionCliHandlerContext) => Promise<void>;
}

/**
 * An extension's CLI contribution declared in its `MakaioExtension` manifest.
 *
 * Full implementation types live in `@makaio/kernel/cli`. This contract
 * keeps the extension layer on the executable shape only.
 */
export interface ExtensionCliContribution extends CliManifest {
  /**
   * Interactive TUI launched when the command is invoked without a subcommand.
   */
  readonly interactive?: (ctx: ExtensionCliInteractiveContext) => Promise<void>;
  /** Declared subcommands exposed by this contribution. */
  readonly subcommands: ReadonlyArray<ExtensionCliSubcommandEntry>;
}
