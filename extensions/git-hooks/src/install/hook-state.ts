/**
 * Persistent state written to `.git/hooks/.makaio-hooks.json` after install.
 *
 * The state file is the single source of truth for uninstall and coverage
 * verification: it records which hooks were installed, their wrapper hashes,
 * and the backup location of any pre-existing hook.
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * Native Git hook names managed by this extension.
 *
 * Limited to post-action hooks so wrappers can preserve Git's operation
 * result while emitting either canonical git events or native hook metadata.
 */
export const GIT_HOOK_NAMES = ['post-commit', 'post-checkout', 'post-merge', 'post-rewrite'] as const;

/** Zod schema for validated native hook names. */
export const GitHookNameSchema = z.enum(GIT_HOOK_NAMES);

/** One of the four native hook names managed by this extension. */
export type GitHookName = z.infer<typeof GitHookNameSchema>;

/**
 * Persisted state for a single installed hook wrapper.
 */
export const GitHookStateEntrySchema = z.object({
  /** The Git hook name (e.g. `'post-commit'`). */
  hookName: GitHookNameSchema,
  /** Absolute path to the installed wrapper script. */
  hookPath: z.string(),
  /**
   * SHA-256 hex digest of the installed wrapper content.
   *
   * Verified on uninstall to detect manual edits that would make automated
   * removal unsafe.
   */
  wrapperHash: z.string(),
  /** Absolute path to the backed-up pre-existing hook, when one existed. */
  backupPath: z.string().optional(),
  /**
   * SHA-256 hex digest of the pre-existing hook at backup time.
   *
   * Verified before restoration to detect post-backup edits.
   */
  backupHash: z.string().optional(),
  /** Whether a hook file existed at this path before installation. */
  previousExists: z.boolean(),
});

/** Persisted state entry for a single native hook wrapper. */
export type GitHookStateEntry = z.infer<typeof GitHookStateEntrySchema>;

/**
 * Full persistent install state written to `.git/hooks/.makaio-hooks.json`.
 */
export const GitHookInstallStateSchema = z.object({
  /** Schema version — currently always `1`. */
  version: z.literal(1),
  /** Absolute path to the repository root. */
  repoRoot: z.string(),
  /** Absolute path to the hooks directory (resolved via `git rev-parse --git-path`). */
  hookDir: z.string(),
  /**
   * Command and arguments used to invoke the receiver binary.
   *
   * Written into each wrapper script so the wrapper does not need to
   * re-read this file at runtime.
   */
  receiverCommand: z.array(z.string()).min(1),
  /** ISO-8601 timestamp of when this install was performed. */
  installedAt: z.string(),
  /**
   * Per-hook state entries, keyed by native hook name.
   *
   * Not all four hooks are guaranteed to be present if an installation fails
   * before all wrappers are written.
   */
  hooks: z.object({
    'post-commit': GitHookStateEntrySchema.optional(),
    'post-checkout': GitHookStateEntrySchema.optional(),
    'post-merge': GitHookStateEntrySchema.optional(),
    'post-rewrite': GitHookStateEntrySchema.optional(),
  }),
});

/** Full persistent install state. */
export type GitHookInstallState = z.infer<typeof GitHookInstallStateSchema>;

/** File name for the install state persisted inside the hooks directory. */
export const STATE_FILE_NAME = '.makaio-hooks.json';
