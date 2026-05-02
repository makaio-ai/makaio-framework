/**
 * Manifest-based Commander command registration.
 *
 * Converts pure-JSON {@link CliManifest} metadata into Commander commands that
 * share a single pre-connected bus instance owned by the CLI entry point.
 *
 * Counterpart to {@link registerContribution} in `schema-adapter.ts`, which
 * operates on live Zod schemas and handler functions. This module operates on
 * serializable manifest data; the local discovery path in `main.ts` enriches
 * that manifest with args derived from the extension's live schema at startup
 * via `toCliArgManifests`, so the Zod schema remains the single source of
 * truth and a CLI module import is required per local extension at discovery.
 */
import type { CliArgManifest, CliManifest, CliSubcommandManifest } from '@makaio/contracts';
import type { CliContribution } from '@makaio/kernel/cli';
import type { IMakaioBus } from '@makaio/bus-core';
import { formatInteractiveTerminalError, formatZodError, hasInteractiveTerminal } from './schema-adapter.js';
import { toCliLongOptionName } from './flag-names.js';
import { createProcessCommandContext } from './command-runtime.js';
import { parseNumericArg } from './cli-arg-parsers.js';
import { formatConnectionError } from './connection-error.js';
import { findOrCreateCommand, claimSubcommandName, type CommandInstance } from './command-tree.js';

// ---------------------------------------------------------------------------
// Public context type
// ---------------------------------------------------------------------------

/**
 * Runtime context passed to {@link registerManifestCommand}.
 *
 * Separates infrastructure concerns (bus, import) from the pure-data manifest
 * so the registration function remains testable without real I/O.
 */
export interface ManifestCommandContext {
  /** Absolute path to the extension's CLI entry module. */
  readonly cliEntryPath: string;
  /**
   * Pre-connected bus instance shared across the entire CLI invocation.
   * `null` when the connection failed (server unreachable, auth failure,
   * timeout) — commands still register for `--help` visibility but actions
   * fail with the contextual error from {@link connectionError}.
   */
  readonly bus: IMakaioBus | null;
  /**
   * Human-readable reason the bus connection failed, or `undefined` when the
   * bus connected successfully. Used to surface the real cause (auth failure,
   * timeout, server unreachable) instead of a generic "Is it running?" message.
   */
  readonly connectionError?: string;
  /**
   * Whether the contribution exports an interactive handler.
   * Drives whether a bare invocation (no subcommand) triggers the TUI or
   * prints help.
   */
  readonly hasInteractive: boolean;
  /**
   * Dynamic import function for the extension's CLI entry module.
   * Injected so tests can stub without filesystem access.
   * @param entryPath - Absolute path to the module to import.
   * @returns The loaded {@link CliContribution}.
   */
  readonly importModule: (entryPath: string) => Promise<CliContribution>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a {@link CliManifest} as a Commander command tree.
 *
 * Creates Commander commands from manifest metadata only. The extension module
 * is imported lazily — only when a command action fires — via
 * {@link ManifestCommandContext.importModule}. The bus is pre-connected by
 * the CLI entry point and provided through {@link ManifestCommandContext.bus};
 * command execution fails fast when it is unavailable, using
 * {@link ManifestCommandContext.connectionError}.
 * @param program - The root Commander program or parent command.
 * @param manifest - Pure-data CLI manifest from `descriptor.json`.
 * @param ctx - Runtime context supplying lazy module import and shared bus state.
 */
export function registerManifestCommand(
  program: CommandInstance,
  manifest: CliManifest,
  ctx: ManifestCommandContext,
): void {
  const { cmd, created } = findOrCreateCommand(program, manifest.name, manifest.description);

  for (const sub of manifest.subcommands ?? []) {
    registerSubcommand(cmd, sub, manifest.name, ctx);
  }

  // Interactive handler is per-command, first registrant wins. Two TUI
  // experiences cannot meaningfully merge — same first-wins as subcommands.
  if (created && ctx.hasInteractive) {
    cmd.action(async () => {
      await resolveAndExecuteInteractive(ctx, manifest.name);
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Register a single {@link CliSubcommandManifest} on a parent Commander command.
 * @param parent - The parent Commander command.
 * @param sub - Subcommand metadata.
 * @param parentName - Name of the parent command (for error messages).
 * @param ctx - Runtime context.
 */
function registerSubcommand(
  parent: CommandInstance,
  sub: CliSubcommandManifest,
  parentName: string,
  ctx: ManifestCommandContext,
): void {
  if (!claimSubcommandName(parent, sub.name, `${parentName} ${sub.name}`, 'extension contribution')) return;
  const cmd = parent.command(sub.name).description(sub.description);

  registerManifestArgs(cmd, sub.args ?? []);

  cmd.action(async () => {
    await resolveAndExecute(ctx, sub.name, cmd, parentName);
  });
}

/**
 * Register arguments and options from {@link CliArgManifest} metadata onto a
 * Commander command.
 * @param cmd - Commander command to add args/options to.
 * @param args - Arg manifests to register.
 */
export function registerManifestArgs(cmd: CommandInstance, args: readonly CliArgManifest[]): void {
  for (const arg of args) {
    if (arg.positional) {
      const syntax = arg.required ? `<${arg.name}>` : `[${arg.name}]`;
      if (arg.type === 'number') {
        cmd.argument(syntax, arg.description, parseNumericArg);
      } else {
        cmd.argument(syntax, arg.description);
      }
    } else {
      const longFlag = `--${toCliLongOptionName(arg.name)}`;
      const flagParts = arg.short ? `${arg.short}, ${longFlag}` : longFlag;
      const isBoolean = arg.type === 'boolean';
      const flags = isBoolean ? flagParts : `${flagParts} <${arg.name}>`;

      if (arg.required) {
        if (arg.type === 'number') {
          cmd.requiredOption(flags, arg.description, parseNumericArg);
        } else {
          cmd.requiredOption(flags, arg.description);
        }
      } else {
        if (arg.type === 'number') {
          cmd.option(flags, arg.description, parseNumericArg);
        } else {
          cmd.option(flags, arg.description);
        }
      }
    }
  }
}

/**
 * Import the extension contribution and execute the matching subcommand handler.
 *
 * Finds the matching subcommand by name, validates parsed args through the
 * subcommand's Zod schema, and invokes the handler. Bus teardown is owned by
 * the CLI entry point, not the individual command executor.
 * @param ctx - Runtime context.
 * @param subcommandName - Name of the subcommand to dispatch to.
 * @param cmd - The Commander command instance after parsing (for arg collection).
 * @param parentName - Top-level command name for error messages.
 */
async function resolveAndExecute(
  ctx: ManifestCommandContext,
  subcommandName: string,
  cmd: CommandInstance,
  parentName: string,
): Promise<void> {
  let contribution: CliContribution;
  try {
    contribution = await ctx.importModule(ctx.cliEntryPath);
  } catch (err) {
    console.error(
      `Failed to load extension CLI module at ${ctx.cliEntryPath}:`,
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
    return;
  }

  if (!contribution || !Array.isArray(contribution.subcommands)) {
    console.error(`CLI entry point at ${ctx.cliEntryPath} does not export a valid CliContribution`);
    process.exitCode = 1;
    return;
  }

  const entry = contribution.subcommands.find((s) => s.name === subcommandName);
  if (!entry) {
    console.error(`Internal error: subcommand '${subcommandName}' not found in '${parentName}' contribution.`);
    process.exitCode = 1;
    return;
  }

  const rawOpts = cmd.opts();
  const rawArgs = collectPositionalArgs(cmd);
  const merged = { ...rawOpts, ...rawArgs };

  const parsed = entry.schema.safeParse(merged);
  if (!parsed.success) {
    cmd.error(formatZodError(parsed.error));
    return;
  }

  if (!ctx.bus) {
    console.error(formatConnectionError(ctx.connectionError));
    process.exitCode = 1;
    return;
  }

  const { context, cleanup } = createProcessCommandContext(parsed.data, ctx.bus);
  try {
    await entry.handler(context);
  } catch (err) {
    console.error(`Command failed:`, err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

/**
 * Import the extension contribution and invoke the interactive handler.
 *
 * Guards against non-TTY environments. Bus teardown is owned by the CLI
 * entry point, not this executor.
 * @param ctx - Runtime context.
 * @param commandName - Top-level command name for error messages.
 */
async function resolveAndExecuteInteractive(ctx: ManifestCommandContext, commandName: string): Promise<void> {
  if (!hasInteractiveTerminal()) {
    console.error(formatInteractiveTerminalError(commandName));
    process.exitCode = 1;
    return;
  }

  let contribution: CliContribution;
  try {
    contribution = await ctx.importModule(ctx.cliEntryPath);
  } catch (err) {
    console.error(
      `Failed to load extension CLI module at ${ctx.cliEntryPath}:`,
      err instanceof Error ? err.message : err,
    );
    process.exitCode = 1;
    return;
  }

  if (!contribution || !contribution.interactive) {
    console.error(
      `'${commandName}' does not provide an interactive handler. ` +
        `Use 'makaio ${commandName} --help' for available subcommands.`,
    );
    process.exitCode = 1;
    return;
  }

  if (!ctx.bus) {
    console.error(formatConnectionError(ctx.connectionError));
    process.exitCode = 1;
    return;
  }

  try {
    await contribution.interactive({ bus: ctx.bus });
  } catch (err) {
    console.error(`Command failed:`, err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

/**
 * Collect positional argument values from a parsed Commander command.
 *
 * Maps `cmd.registeredArguments` names to the corresponding values in
 * `cmd.processedArgs`, which preserves Commander argument-parser coercions.
 * Falling back to `cmd.args` would silently turn manifest-declared number
 * positionals back into strings before Zod validation.
 * @param cmd - The Commander command after parsing.
 * @returns An object mapping positional argument names to their parsed values.
 */
export function collectPositionalArgs(cmd: CommandInstance): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const args = cmd.processedArgs;

  for (let i = 0; i < cmd.registeredArguments.length; i++) {
    const argDef = cmd.registeredArguments[i];
    if (argDef !== undefined && i < args.length) {
      result[argDef.name()] = args[i];
    }
  }

  return result;
}
