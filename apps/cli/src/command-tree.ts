/**
 * Commander command-tree composition utilities.
 *
 * Centralizes find-or-create semantics so multiple registration paths
 * (manifest, contribution, native-client, remote) can merge subcommands
 * into a shared parent command without crashing on duplicate names.
 */
import { Command } from 'commander';

export type CommandInstance = InstanceType<typeof Command>;

/**
 * Result of {@link findOrCreateCommand}.
 */
export interface FindOrCreateResult {
  /** The existing or newly created Commander command. */
  readonly cmd: CommandInstance;
  /** `true` when a new command was created, `false` when an existing one was found. */
  readonly created: boolean;
}

/**
 * Retrieve an existing child command by name, or create and attach a new one.
 *
 * Registration paths that legitimately contribute subcommands under the same
 * parent name (e.g. a built-in and an extension both targeting
 * `makaio client`) call this instead of `parent.command(name)` directly.
 * When the command already exists its description is left unchanged — the
 * first registrant's description wins.
 * @param parent - The parent Commander command or root program.
 * @param name - Command name to find or create.
 * @param description - Description used only when creating a new command.
 * @returns The command instance and whether it was freshly created.
 */
export function findOrCreateCommand(parent: CommandInstance, name: string, description: string): FindOrCreateResult {
  const existing = parent.commands.find((c) => c.name() === name);
  if (existing !== undefined) {
    return { cmd: existing, created: false };
  }
  const cmd = parent.command(name).description(description);
  return { cmd, created: true };
}

/**
 * Determine whether a command name is already registered as a direct child.
 *
 * Use this in registration paths where skip-on-collision is the correct
 * behavior (e.g. remote commands losing to local, per-client shortcuts
 * deferring to pre-registered names).
 * @param parent - The parent Commander command or root program.
 * @param name - Command name to probe.
 * @returns `true` when the name is already present as a direct child.
 */
export function hasRegisteredCommandName(parent: CommandInstance, name: string): boolean {
  return parent.commands.some((c) => c.name() === name);
}

/**
 * Claim a subcommand name on a parent, warning and returning `false` on collision.
 *
 * Use this before calling `parent.command(name)` when merging subcommands from
 * multiple registration sources into a shared parent. The first registrant wins;
 * subsequent attempts log a `[cli]` warning and return `false` so the caller
 * can skip registration without crashing.
 * @param parent - The parent Commander command.
 * @param subName - The child command name to claim.
 * @param qualifiedName - Full `parent sub` string for the warning message.
 * @param source - Registration source label for the warning.
 * @returns `true` when the name is free; `false` when already taken.
 */
export function claimSubcommandName(
  parent: CommandInstance,
  subName: string,
  qualifiedName: string,
  source: string,
): boolean {
  if (hasRegisteredCommandName(parent, subName)) {
    console.warn(`[cli] Subcommand '${qualifiedName}' is already registered; skipping duplicate from ${source}.`);
    return false;
  }
  return true;
}
