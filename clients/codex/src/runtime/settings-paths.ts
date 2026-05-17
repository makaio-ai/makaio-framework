/**
 * Codex client settings path resolution.
 *
 * Provides a pure utility for computing the filesystem paths where Codex
 * stores its `hooks.json` configuration files — one global path under the
 * resolved Codex config directory and an optional project-scoped path.
 *
 * No filesystem I/O is performed; callers are responsible for reading,
 * writing, or watching the returned paths.
 * @packageDocumentation
 */

import os from 'node:os';
import path from 'node:path';

/** Resolved home directory, captured once at module load time. */
const HOME_DIR = os.homedir();

/**
 * Resolved filesystem paths for Codex `hooks.json` configuration files.
 *
 * The global path is always present.  The project-scoped path is present
 * only when a `projectDir` was supplied to {@link resolveCodexSettingsPaths}.
 */
export interface CodexSettingsPaths {
  /** Absolute path to the global `hooks.json` file — always present. */
  readonly globalHooks: string;
  /**
   * Absolute path to `{projectDir}/.codex/hooks.json`.
   *
   * `null` when no `projectDir` was provided to
   * {@link resolveCodexSettingsPaths}.
   */
  readonly projectHooks: string | null;
}

/**
 * Resolve the filesystem paths for Codex `hooks.json` configuration files.
 *
 * This is a pure function: it performs no I/O and has no side effects.
 * The returned paths may or may not exist on disk.
 * @param projectDir - Absolute path to the project root directory. When
 *   provided, {@link CodexSettingsPaths.projectHooks} is set to
 *   `{projectDir}/.codex/hooks.json`. When omitted, `projectHooks` is `null`.
 * @param configDir - Optional Codex config root. When omitted, the global
 *   hooks path falls back to `~/.codex/hooks.json`.
 * @returns Resolved paths for the global and optional project-scoped Codex
 *   hooks configuration files.
 */
// The .codex/ path segments are intentionally hardcoded — this is the
// Codex-specific client package, not generic framework code. The path layout
// is a Codex constant (there is no second consumer needing different paths).
// No runtime assertion on projectDir: this is an internal function called only
// by CodexClientSettings, which receives projectDir from bus request payloads
// originating in framework services. Validation belongs at the system boundary,
// not at every internal call site.
export function resolveCodexSettingsPaths(projectDir?: string, configDir?: string): CodexSettingsPaths {
  const globalRoot = configDir ?? path.join(HOME_DIR, '.codex');
  return {
    globalHooks: path.join(globalRoot, 'hooks.json'),
    projectHooks: projectDir !== undefined ? path.join(projectDir, '.codex', 'hooks.json') : null,
  };
}
