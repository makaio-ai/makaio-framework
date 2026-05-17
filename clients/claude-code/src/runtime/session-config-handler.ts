/**
 * Claude Code session config setup handler.
 *
 * Implements the `client:claude-code.sessionConfig.setup` delegation request
 * by copying native Claude Code config files from the base config directory
 * into the session-scoped directory.  On macOS, credentials are managed by
 * Keychain and are **not** copied or symlinked; on Linux and Windows the
 * `.credentials.json` file is symlinked from the base dir into the session dir
 * so the process can authenticate without prompting the user. When Windows
 * denies symlink creation, credentials are copied into the isolated session
 * directory instead.
 *
 * Returns `{ env: { CLAUDE_CONFIG_DIR: sessionDir } }` so the spawned process
 * inherits the isolated session directory as its configuration root.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionConfigSetupRequest, SessionConfigSetupResponse } from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Copy `src` to `dst`, falling back to `onMissing` behaviour when `src` does
 * not exist.
 *
 * - `'create-empty'`: writes `{}` to `dst` so the session dir always contains
 *   parsable JSON.
 * - `'skip'`: leaves `dst` untouched.
 * @param src - Source path to copy from (may not exist)
 * @param dst - Destination path to write to
 * @param onMissing - What to do when `src` is absent
 */
async function tryCopyFile(src: string, dst: string, onMissing: 'create-empty' | 'skip'): Promise<void> {
  try {
    await fs.copyFile(src, dst);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (onMissing === 'create-empty') await fs.writeFile(dst, '{}', 'utf-8');
  }
}

/**
 * Resolve the source directory for session config materialization.
 *
 * `ClientSessionConfigService` passes `sessionDir` as `baseConfigDir` when no
 * profile/default profile exists. For Claude Code that means "copy from the
 * native config home" while still treating the native files as immutable.
 * @param sessionDir - Session-scoped destination directory.
 * @param baseConfigDir - Requested source directory.
 * @returns Source directory for files copied or linked into the session dir.
 */
function resolveSourceConfigDir(sessionDir: string, baseConfigDir: string): string {
  if (path.resolve(sessionDir) === path.resolve(baseConfigDir)) {
    return path.join(os.homedir(), '.claude');
  }
  return baseConfigDir;
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

/**
 * Handle `client:claude-code.sessionConfig.setup` by seeding the
 * session-scoped directory with the appropriate Claude Code config files.
 *
 * The following files are handled:
 * - `settings.json` — always present in the session dir; copied from
 *   `baseConfigDir` or created as an empty JSON object when the source does
 *   not exist.
 * - `settings.local.json` — copied only when present in `baseConfigDir`.
 * - `.credentials.json` — symlinked from `baseConfigDir` on Linux/Windows,
 *   with a Windows copy fallback when symlink creation is denied. On macOS
 *   Claude Code uses Keychain, so the credentials file is omitted.
 *
 * This function is intentionally pure with respect to the bus — it receives
 * the already-validated payload and performs only filesystem operations.
 * @param payload - Validated setup-delegation payload carrying `sessionDir`,
 *   `baseConfigDir`, and `platform`
 * @returns Response carrying the `CLAUDE_CONFIG_DIR` env var for the session
 */
export async function handleClaudeCodeSessionConfigSetup(
  payload: SessionConfigSetupRequest,
): Promise<SessionConfigSetupResponse> {
  const { sessionDir, baseConfigDir, platform } = payload;
  const sourceConfigDir = resolveSourceConfigDir(sessionDir, baseConfigDir);

  // settings.json — copy or seed empty so the session dir is always valid.
  await tryCopyFile(
    path.join(sourceConfigDir, 'settings.json'),
    path.join(sessionDir, 'settings.json'),
    'create-empty',
  );

  // settings.local.json — optional local overrides; skip when absent.
  await tryCopyFile(
    path.join(sourceConfigDir, 'settings.local.json'),
    path.join(sessionDir, 'settings.local.json'),
    'skip',
  );

  // macOS uses Keychain for credentials — symlink only on Linux/Windows.
  if (platform !== 'darwin') {
    const credSrc = path.join(sourceConfigDir, '.credentials.json');
    const credDst = path.join(sessionDir, '.credentials.json');
    try {
      await fs.symlink(credSrc, credDst);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        await tryCopyFile(credSrc, credDst, 'skip');
      } else if (code !== 'ENOENT' && code !== 'EEXIST') {
        throw error;
      }
    }
  }

  return { env: { CLAUDE_CONFIG_DIR: sessionDir } };
}
