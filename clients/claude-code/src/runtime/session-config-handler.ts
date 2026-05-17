/**
 * Claude Code session config setup handler.
 *
 * Implements the `client:claude-code.sessionConfig.setup` delegation request
 * by materializing the requested slice of native Claude Code config into the
 * session-scoped directory. The `configInheritance` policy controls whether
 * the session inherits settings plus auth (`full`), auth/startup state only
 * (`auth-only`), or neither (`empty`). Settings copies always remove stale
 * Makaio-managed hook/statusline wiring before adapter-specific wiring is
 * applied.
 *
 * On macOS, client-owned native credential helpers clone the Keychain entry to
 * Claude Code's `CLAUDE_CONFIG_DIR`-hashed service name. On Linux and Windows,
 * `.credentials.json` is symlinked from the base dir into the session dir so
 * the process can authenticate without prompting the user. When Windows denies
 * symlink creation, credentials are copied into the isolated session directory
 * instead.
 *
 * Returns `{ env: { CLAUDE_CONFIG_DIR: sessionDir } }` so the spawned process
 * inherits the isolated session directory as its configuration root.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionConfigSetupRequest, SessionConfigSetupResponse } from '@makaio/contracts/client';
import { scrubManagedClaudeCodeWiring } from './client-settings-modifiers.js';
import {
  clearClaudeCodeNativeCredentialsForSession,
  inheritClaudeCodeNativeCredentialsForSession,
} from './native-credentials.js';

/** Claude Code global-state keys needed for auth and non-interactive startup. */
const AUTH_STATE_KEYS = [
  'oauthAccount',
  'customApiKeyResponses',
  'userID',
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
] as const;

/** Claude Code project-state fields needed to suppress the folder trust prompt. */
const TRUSTED_PROJECT_STATE = {
  hasTrustDialogAccepted: true,
} as const;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Copy a settings file and optionally remove stale Makaio-managed wiring.
 * @param src - Source settings path.
 * @param dst - Destination settings path.
 * @param onMissing - What to do when `src` is absent.
 * @param scrub - Whether to remove Makaio-managed hook/statusline entries.
 */
async function tryMaterializeSettingsFile(
  src: string,
  dst: string,
  onMissing: 'create-empty' | 'skip',
  scrub: boolean,
): Promise<void> {
  try {
    const content = await fs.readFile(src, 'utf-8');
    if (!scrub) {
      await fs.writeFile(dst, content, 'utf-8');
      return;
    }

    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const parsedKind = Array.isArray(parsed) ? 'array' : typeof parsed;
      throw new SyntaxError(`Settings file at '${src}' contains non-object JSON: ${parsedKind}`);
    }
    await fs.writeFile(dst, JSON.stringify(scrubManagedClaudeCodeWiring(parsed as Record<string, unknown>)), 'utf-8');
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

/**
 * Resolve the current native Claude Code config directory.
 * @returns Native `~/.claude` config directory for the active environment.
 */
function resolveNativeClaudeConfigDir(): string {
  return path.join(os.homedir(), '.claude');
}

/**
 * Resolve Claude Code's global state file for a source config directory.
 *
 * Native Claude Code stores settings under `~/.claude/settings.json`, while
 * account/onboarding state lives beside it at `~/.claude.json`.  Profile dirs
 * can keep their isolated state file directly inside the profile directory.
 * @param sourceConfigDir - Resolved source config directory.
 * @returns Candidate `.claude.json` path.
 */
function resolveSourceStatePath(sourceConfigDir: string): string {
  const nativeConfigDir = resolveNativeClaudeConfigDir();
  if (path.resolve(sourceConfigDir) === path.resolve(nativeConfigDir)) {
    return path.join(path.dirname(nativeConfigDir), '.claude.json');
  }
  return path.join(sourceConfigDir, '.claude.json');
}

/**
 * Resolve the canonical project key Claude Code uses in `.claude.json`.
 * @param projectDir - Absolute project directory passed to the spawned client.
 * @returns Realpath-normalized project key, or the resolved path if missing.
 */
async function resolveProjectStateKey(projectDir: string): Promise<string> {
  try {
    return await fs.realpath(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.resolve(projectDir);
  }
}

/**
 * Copy only Claude Code auth/onboarding state into the session directory.
 * @param sourceConfigDir - Resolved source config directory.
 * @param sessionDir - Session-scoped config directory.
 * @param projectDir - Project directory to mark trusted for non-interactive startup.
 */
async function inheritAuthState(
  sourceConfigDir: string,
  sessionDir: string,
  projectDir: string | undefined,
): Promise<void> {
  const sourceStatePath = resolveSourceStatePath(sourceConfigDir);
  const destStatePath = path.join(sessionDir, '.claude.json');
  const authState: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(sourceStatePath, 'utf-8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const source = parsed as Record<string, unknown>;
      for (const key of AUTH_STATE_KEYS) {
        if (source[key] !== undefined) {
          authState[key] = source[key];
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (projectDir !== undefined) {
    const projectKey = await resolveProjectStateKey(projectDir);
    authState['projects'] = {
      [projectKey]: TRUSTED_PROJECT_STATE,
    };
  }

  if (Object.keys(authState).length > 0) {
    await fs.writeFile(destStatePath, JSON.stringify(authState), 'utf-8');
  } else {
    await fs.rm(destStatePath, { force: true });
  }
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
 * - macOS Keychain credentials — cloned for `full` and `auth-only` to the
 *   session-specific service name Claude Code derives from `CLAUDE_CONFIG_DIR`.
 * - `.credentials.json` — inherited for `full` and `auth-only` on
 *   Linux/Windows, with a Windows copy fallback when symlink creation is
 *   denied.
 * - `.claude.json` — filtered to auth/onboarding keys for `full` and
 *   `auth-only`; when `projectDir` is provided, only the matching folder trust
 *   marker is added. Other project and cache state is not inherited.
 *
 * This function is intentionally pure with respect to the bus — it receives
 * the already-validated payload and performs local filesystem/keychain
 * operations without exposing credential material as a bus payload.
 * @param payload - Validated setup-delegation payload carrying `sessionDir`,
 *   `baseConfigDir`, and `platform`
 * @returns Response carrying the `CLAUDE_CONFIG_DIR` env var for the session
 */
export async function handleClaudeCodeSessionConfigSetup(
  payload: SessionConfigSetupRequest,
): Promise<SessionConfigSetupResponse> {
  const { sessionDir, baseConfigDir, platform, configInheritance, projectDir } = payload;
  const sourceConfigDir = resolveSourceConfigDir(sessionDir, baseConfigDir);

  if (configInheritance === 'full') {
    await tryMaterializeSettingsFile(
      path.join(sourceConfigDir, 'settings.json'),
      path.join(sessionDir, 'settings.json'),
      'create-empty',
      true,
    );
    await tryMaterializeSettingsFile(
      path.join(sourceConfigDir, 'settings.local.json'),
      path.join(sessionDir, 'settings.local.json'),
      'skip',
      true,
    );
    await inheritClaudeCodeNativeCredentialsForSession({ sourceConfigDir, sessionDir, platform });
    await inheritAuthState(sourceConfigDir, sessionDir, projectDir);
  } else {
    await fs.writeFile(path.join(sessionDir, 'settings.json'), '{}', 'utf-8');
    await fs.rm(path.join(sessionDir, 'settings.local.json'), { force: true });
    await fs.rm(path.join(sessionDir, '.claude.json'), { force: true });
    await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform });
    if (configInheritance === 'auth-only') {
      await inheritClaudeCodeNativeCredentialsForSession({ sourceConfigDir, sessionDir, platform });
      await inheritAuthState(sourceConfigDir, sessionDir, projectDir);
    }
  }

  return { env: { CLAUDE_CONFIG_DIR: sessionDir } };
}
