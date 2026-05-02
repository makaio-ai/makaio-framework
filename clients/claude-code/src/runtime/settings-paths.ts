/**
 * Claude Code settings path resolution.
 *
 * Provides a pure, side-effect-free function that maps each available settings
 * scope to its canonical file-system path.  No file I/O is performed — callers
 * are responsible for reading or writing the resolved paths.
 * @packageDocumentation
 */

import * as os from 'node:os';
import * as path from 'node:path';

import type { ClaudeCodeScope } from '../schemas/config.js';

/**
 * A resolved settings file path paired with its settings scope.
 */
export interface ClaudeCodeSettingsPath {
  /** The scope this path belongs to. */
  readonly scope: ClaudeCodeScope;
  /** Absolute path to the settings file for this scope. */
  readonly path: string;
}

/**
 * Options for {@link resolveClaudeCodeSettingsPaths}.
 */
export interface ResolveClaudeCodeSettingsPathsOptions {
  /**
   * Absolute path to the project root directory.  When provided, the
   * `project` and `local` scopes are included in the result.  Absolute-path
   * enforcement is the caller's responsibility — the bus schema layer
   * validates this via `AbsolutePathSchema` before requests reach here.
   */
  readonly projectDir?: string;
  /**
   * Override for the user-scope config directory.  When provided, the user
   * scope settings file is resolved as `<configDir>/settings.json` instead of
   * the default `~/.claude/settings.json`.  This is the primary seam for
   * binary-isolated Claude Code instances that store their config in a
   * process-local directory rather than the shared home directory.
   */
  readonly configDir?: string;
}

/**
 * Resolve the canonical file-system paths for all applicable Claude Code
 * settings scopes.
 *
 * The `user` scope is always present.  The `project` and `local` scopes are
 * included only when `projectDir` is provided.
 *
 * The function is deterministic and performs no file I/O — the returned paths
 * may or may not exist on disk.
 * @param options - Optional resolution parameters.  Pass `{ projectDir }` to
 *   include project/local scopes, `{ configDir }` to redirect the user-scope
 *   path to an isolated directory, or both together.  When omitted entirely,
 *   the user scope resolves to `~/.claude/settings.json` (unchanged behaviour).
 * @returns An ordered array of {@link ClaudeCodeSettingsPath} entries, from
 *   broadest scope (`user`) to narrowest (`local`).
 */
export function resolveClaudeCodeSettingsPaths(
  options?: ResolveClaudeCodeSettingsPathsOptions,
): ClaudeCodeSettingsPath[] {
  const configDir = options?.configDir ?? path.join(os.homedir(), '.claude');
  const projectDir = options?.projectDir;

  const results: ClaudeCodeSettingsPath[] = [
    {
      scope: 'user',
      path: path.join(configDir, 'settings.json'),
    },
  ];

  if (projectDir !== undefined && projectDir !== '') {
    results.push(
      {
        scope: 'project',
        path: path.join(projectDir, '.claude', 'settings.json'),
      },
      {
        scope: 'local',
        path: path.join(projectDir, '.claude', 'settings.local.json'),
      },
    );
  }

  return results;
}
