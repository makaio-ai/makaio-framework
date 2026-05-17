/**
 * Handlers for `makaio client profile-*` subcommands.
 *
 * Each handler dispatches a `client.profile.*` request to the global profile
 * service via the bus and formats the result for terminal output.
 *
 * **Invariants:**
 * - Fail fast: if the bus request fails (no handler, validation error, etc.),
 *   write an error message and set exit code 1.
 * - Never reads or writes config files directly — all I/O is delegated to the
 *   profile service via the bus.
 * @packageDocumentation
 */

import { execFile } from 'node:child_process';
import type { IMakaioBus } from '@makaio/bus-core';
import { type ClientProfile, ClientSubjects } from '@makaio/contracts/client';
import { requireBus, type CommandContext } from '@makaio/kernel/cli';

// ---------------------------------------------------------------------------
// Public args shapes
// ---------------------------------------------------------------------------

/**
 * Parsed CLI argument shape for the `client profile-list` subcommand.
 */
export interface ProfileListArgs {
  /** Stable client identifier (e.g. `'claude-code'`, `'codex'`). */
  readonly client: string;
}

/**
 * Parsed CLI argument shape for the `client profile-create` subcommand.
 */
export interface ProfileCreateArgs {
  /** Stable client identifier (e.g. `'claude-code'`, `'codex'`). */
  readonly client: string;
  /** Human-readable name for the new profile. */
  readonly name: string;
  /** Optional description for the new profile. */
  readonly description?: string;
}

/**
 * Parsed CLI argument shape for the `client profile-delete` subcommand.
 */
export interface ProfileDeleteArgs {
  /** Stable client identifier (e.g. `'claude-code'`, `'codex'`). */
  readonly client: string;
  /** Name of the profile to delete. */
  readonly name: string;
}

/**
 * Parsed CLI argument shape for the `client profile-default` subcommand.
 */
export interface ProfileDefaultArgs {
  /** Stable client identifier (e.g. `'claude-code'`, `'codex'`). */
  readonly client: string;
  /** Name of the profile to set as the default. */
  readonly name: string;
}

/**
 * Parsed CLI argument shape for the `client profile-show` subcommand.
 */
export interface ProfileShowArgs {
  /** Stable client identifier (e.g. `'claude-code'`, `'codex'`). */
  readonly client: string;
  /** Name of the profile to display. */
  readonly name: string;
}

/**
 * Parsed CLI argument shape for the `client profile-open` subcommand.
 */
export interface ProfileOpenArgs {
  /** Stable client identifier (e.g. `'claude-code'`, `'codex'`). */
  readonly client: string;
  /** Name of the profile whose config directory to open. */
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Narrow context interface (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Narrow command context used by the `run*` profile command functions.
 *
 * Extracting the minimal surface area makes each handler fully testable
 * without constructing a real {@link CommandContext}.
 * @typeParam TArgs - Parsed argument shape for the specific subcommand.
 */
export interface ProfileCommandContext<TArgs> {
  /** Parsed CLI arguments. */
  readonly args: TArgs;
  /** Bus façade used to dispatch profile requests. */
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

/** Narrow context for {@link runProfileListCommand}. */
export type ProfileListCommandContext = ProfileCommandContext<ProfileListArgs>;
/** Narrow context for {@link runProfileCreateCommand}. */
export type ProfileCreateCommandContext = ProfileCommandContext<ProfileCreateArgs>;
/** Narrow context for {@link runProfileDeleteCommand}. */
export type ProfileDeleteCommandContext = ProfileCommandContext<ProfileDeleteArgs>;
/** Narrow context for {@link runProfileDefaultCommand}. */
export type ProfileDefaultCommandContext = ProfileCommandContext<ProfileDefaultArgs>;
/** Narrow context for {@link runProfileShowCommand}. */
export type ProfileShowCommandContext = ProfileCommandContext<ProfileShowArgs>;
/** Narrow context for {@link runProfileOpenCommand}. */
export type ProfileOpenCommandContext = ProfileCommandContext<ProfileOpenArgs>;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format an unknown thrown value as a readable error string.
 * @param error - Value thrown by a catch clause
 * @returns Error message string
 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Format a single profile as a human-readable line for list output.
 * @param profile - The profile record to format.
 * @returns A single line of text (without trailing newline).
 */
function formatProfileLine(profile: ClientProfile): string {
  const marker = profile.isDefault ? '* ' : '  ';
  const desc = profile.description != null ? `  — ${profile.description}` : '';
  return `${marker}${profile.name}${desc}  [${profile.configDir}]`;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * CLI entry handler for `makaio client profile-list <client>`.
 *
 * Delegates to {@link runProfileListCommand} with the real bus context.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleProfileList(ctx: CommandContext<ProfileListArgs>): Promise<void> {
  await runProfileListCommand({ ...ctx, bus: requireBus(ctx) });
}

/**
 * Execute the profile list command.
 *
 * Requests all profiles for the given client and prints one line per profile.
 * The default profile is indicated with a `*` prefix. On bus failure, writes a
 * diagnostic message and sets exit code 1.
 * @param ctx - Narrow command context (args + bus + output + setExitCode).
 */
export async function runProfileListCommand(ctx: ProfileListCommandContext): Promise<void> {
  const { client: clientId } = ctx.args;

  try {
    const result = await ctx.bus.request(ClientSubjects.profile.list, { clientId });

    if (result.profiles.length === 0) {
      ctx.output.write(`No profiles found for client '${clientId}'.\n`);
      return;
    }

    for (const profile of result.profiles) {
      ctx.output.write(`${formatProfileLine(profile)}\n`);
    }
  } catch (error) {
    const reason = formatError(error);
    ctx.output.error(`Failed to list profiles for '${clientId}'. Reason: ${reason}\n`);
    ctx.setExitCode(1);
  }
}

/**
 * CLI entry handler for `makaio client profile-create <client> <name>`.
 *
 * Delegates to {@link runProfileCreateCommand} with the real bus context.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleProfileCreate(ctx: CommandContext<ProfileCreateArgs>): Promise<void> {
  await runProfileCreateCommand({ ...ctx, bus: requireBus(ctx) });
}

/**
 * Execute the profile create command.
 *
 * Dispatches `client.profile.create` via the bus and reports the created
 * profile's name and config directory. On failure, writes a diagnostic message
 * and sets exit code 1.
 * @param ctx - Narrow command context (args + bus + output + setExitCode).
 */
export async function runProfileCreateCommand(ctx: ProfileCreateCommandContext): Promise<void> {
  const { client: clientId, name, description } = ctx.args;

  try {
    const result = await ctx.bus.request(ClientSubjects.profile.create, {
      clientId,
      name,
      description,
    });
    ctx.output.write(
      `Created profile '${result.profile.name}' for client '${clientId}'.\n  Config dir: ${result.profile.configDir}\n`,
    );
  } catch (error) {
    const reason = formatError(error);
    ctx.output.error(`Failed to create profile '${name}' for '${clientId}'. Reason: ${reason}\n`);
    ctx.setExitCode(1);
  }
}

/**
 * CLI entry handler for `makaio client profile-delete <client> <name>`.
 *
 * Delegates to {@link runProfileDeleteCommand} with the real bus context.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleProfileDelete(ctx: CommandContext<ProfileDeleteArgs>): Promise<void> {
  await runProfileDeleteCommand({ ...ctx, bus: requireBus(ctx) });
}

/**
 * Execute the profile delete command.
 *
 * Dispatches `client.profile.delete` via the bus and confirms deletion. On
 * failure, writes a diagnostic message and sets exit code 1.
 * @param ctx - Narrow command context (args + bus + output + setExitCode).
 */
export async function runProfileDeleteCommand(ctx: ProfileDeleteCommandContext): Promise<void> {
  const { client: clientId, name } = ctx.args;

  try {
    await ctx.bus.request(ClientSubjects.profile.delete, { clientId, name });
    ctx.output.write(`Deleted profile '${name}' for client '${clientId}'.\n`);
  } catch (error) {
    const reason = formatError(error);
    ctx.output.error(`Failed to delete profile '${name}' for '${clientId}'. Reason: ${reason}\n`);
    ctx.setExitCode(1);
  }
}

/**
 * CLI entry handler for `makaio client profile-default <client> <name>`.
 *
 * Delegates to {@link runProfileDefaultCommand} with the real bus context.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleProfileDefault(ctx: CommandContext<ProfileDefaultArgs>): Promise<void> {
  await runProfileDefaultCommand({ ...ctx, bus: requireBus(ctx) });
}

/**
 * Execute the profile default command.
 *
 * Dispatches `client.profile.setDefault` via the bus and confirms the change.
 * On failure, writes a diagnostic message and sets exit code 1.
 * @param ctx - Narrow command context (args + bus + output + setExitCode).
 */
export async function runProfileDefaultCommand(ctx: ProfileDefaultCommandContext): Promise<void> {
  const { client: clientId, name } = ctx.args;

  try {
    await ctx.bus.request(ClientSubjects.profile.setDefault, { clientId, name });
    ctx.output.write(`Set '${name}' as the default profile for client '${clientId}'.\n`);
  } catch (error) {
    const reason = formatError(error);
    ctx.output.error(`Failed to set default profile '${name}' for '${clientId}'. Reason: ${reason}\n`);
    ctx.setExitCode(1);
  }
}

/**
 * CLI entry handler for `makaio client profile-show <client> <name>`.
 *
 * Delegates to {@link runProfileShowCommand} with the real bus context.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleProfileShow(ctx: CommandContext<ProfileShowArgs>): Promise<void> {
  await runProfileShowCommand({ ...ctx, bus: requireBus(ctx) });
}

/**
 * Execute the profile show command.
 *
 * Fetches a named profile via `client.profile.get` and prints its details. If
 * the profile does not exist, writes a "not found" message and sets exit code 1.
 * On bus failure, writes a diagnostic message and sets exit code 1.
 * @param ctx - Narrow command context (args + bus + output + setExitCode).
 */
export async function runProfileShowCommand(ctx: ProfileShowCommandContext): Promise<void> {
  const { client: clientId, name } = ctx.args;

  try {
    const result = await ctx.bus.request(ClientSubjects.profile.get, { clientId, name });

    if (result.profile === null) {
      ctx.output.error(`Profile '${name}' not found for client '${clientId}'.\n`);
      ctx.setExitCode(1);
      return;
    }

    const { profile } = result;
    const desc = profile.description != null ? `\n  Description: ${profile.description}` : '';
    const defaultLabel = profile.isDefault ? ' (default)' : '';
    ctx.output.write(
      `Profile: ${profile.name}${defaultLabel}${desc}\n  Config dir: ${profile.configDir}\n  ID: ${profile.id}\n`,
    );
  } catch (error) {
    const reason = formatError(error);
    ctx.output.error(`Failed to retrieve profile '${name}' for '${clientId}'. Reason: ${reason}\n`);
    ctx.setExitCode(1);
  }
}

/**
 * CLI entry handler for `makaio client profile-open <client> <name>`.
 *
 * Delegates to {@link runProfileOpenCommand} with the real bus context.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleProfileOpen(ctx: CommandContext<ProfileOpenArgs>): Promise<void> {
  await runProfileOpenCommand({ ...ctx, bus: requireBus(ctx) });
}

/**
 * Execute the profile open command.
 *
 * Fetches the named profile to resolve its `configDir`, then opens that
 * directory in the platform's default file manager (`open` on macOS,
 * `xdg-open` on Linux, `explorer` on Windows). If the profile does not exist,
 * writes an error and sets exit code 1.
 * @param ctx - Narrow command context (args + bus + output + setExitCode).
 */
export async function runProfileOpenCommand(ctx: ProfileOpenCommandContext): Promise<void> {
  const { client: clientId, name } = ctx.args;

  let configDir: string;
  try {
    const result = await ctx.bus.request(ClientSubjects.profile.get, { clientId, name });

    if (result.profile === null) {
      ctx.output.error(`Profile '${name}' not found for client '${clientId}'.\n`);
      ctx.setExitCode(1);
      return;
    }

    configDir = result.profile.configDir;
  } catch (error) {
    const reason = formatError(error);
    ctx.output.error(`Failed to retrieve profile '${name}' for '${clientId}'. Reason: ${reason}\n`);
    ctx.setExitCode(1);
    return;
  }

  const platform = process.platform;
  const openCommand = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';

  execFile(openCommand, [configDir], (error) => {
    if (error) {
      ctx.output.error(`Failed to open config directory '${configDir}'. Reason: ${error.message}\n`);
      ctx.setExitCode(1);
    }
  });
}
