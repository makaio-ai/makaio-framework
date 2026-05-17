/**
 * Codex session config setup handler.
 *
 * Implements the `client:codex.sessionConfig.setup` delegation request by
 * materializing the Codex config files needed for an isolated session
 * directory.
 *
 * The handler copies `config.toml` and `auth.json` from the base config
 * directory (when present) into the session-scoped directory, then primes the
 * session directory to ensure `check_for_update_on_startup = false` is set.
 *
 * When `sessionDir` and `baseConfigDir` resolve to the same path (the
 * framework passes `sessionDir` as `baseConfigDir` when no profile is
 * configured) the copy step is skipped and only the prime step runs.
 *
 * Returns `{ env: { CODEX_HOME: sessionDir } }` so the spawned Codex process
 * inherits the isolated session directory as its configuration root.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionConfigSetupRequest, SessionConfigSetupResponse } from '@makaio/contracts/client';
import { handleCodexConfigPrime } from './config-prime-handler.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Copy a file if it exists at the source path; silently skip when absent.
 * @param src - Source file path.
 * @param dst - Destination file path.
 */
async function copyIfPresent(src: string, dst: string): Promise<void> {
  try {
    await fs.copyFile(src, dst);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

/**
 * Handle `client:codex.sessionConfig.setup` by seeding the session-scoped
 * directory with the appropriate Codex config files.
 *
 * Steps:
 * 1. Create `sessionDir` (recursive, no-op when it already exists).
 * 2. When `sessionDir` and `baseConfigDir` are distinct paths, copy
 * `config.toml` and `auth.json` from `baseConfigDir` into `sessionDir`
 * (each copy is skipped when the source file does not exist).
 * 3. Prime `sessionDir` via {@link handleCodexConfigPrime} to ensure
 * `check_for_update_on_startup = false` is set.
 * @param payload - Session config setup delegation payload. Only `sessionDir`,
 *   `baseConfigDir`, and `projectDir` are used; `platform` and
 *   `configInheritance` are accepted for interface compatibility but are not
 *   required for Codex's simpler config model.
 * @returns Environment variables for the spawned Codex process: `CODEX_HOME`
 *   pointing to `sessionDir`.
 */
export async function handleCodexSessionConfigSetup(
  payload: SessionConfigSetupRequest,
): Promise<SessionConfigSetupResponse> {
  const { sessionDir, baseConfigDir, projectDir } = payload;

  await fs.mkdir(sessionDir, { recursive: true });

  if (path.resolve(sessionDir) !== path.resolve(baseConfigDir)) {
    await copyIfPresent(path.join(baseConfigDir, 'config.toml'), path.join(sessionDir, 'config.toml'));
    await copyIfPresent(path.join(baseConfigDir, 'auth.json'), path.join(sessionDir, 'auth.json'));
  }

  await handleCodexConfigPrime({
    clientId: 'codex',
    configDir: sessionDir,
    phase: 'session-create',
    ...(projectDir !== undefined ? { projectDir } : {}),
  });

  return { env: { CODEX_HOME: sessionDir } };
}
