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
 * Claude Code's isolated secure-storage service name. On Linux and Windows,
 * `.credentials.json` is symlinked from the base dir into the session dir so
 * the process can authenticate without prompting the user. When Windows denies
 * symlink creation, credentials are copied into the isolated session directory
 * instead.
 *
 * The session directory is an ephemeral auth/settings sandbox whose lifetime
 * is one connector lease — native session state is explicitly out of its
 * scope. For inheriting policies the `projects/` transcript store is therefore
 * linked to the durable config source rather than created inside the lease, so
 * `--resume`/`--fork-session` from any later lease of the same source can find
 * conversations that earlier leases recorded.
 *
 * Returns the isolated config environment together with whether native
 * credentials were materialized for the requested inheritance policy.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionConfigSetupRequest, SessionConfigSetupResponse } from '@makaio/contracts/client';
import { scrubManagedClaudeCodeWiring } from './client-settings-modifiers.js';
import { handleClaudeCodeConfigPrime } from './config-prime-handler.js';
import {
  clearClaudeCodeNativeCredentialsForSession,
  inheritClaudeCodeNativeCredentialsForSession,
  resolveKeychainAccount,
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
    return resolveNativeClaudeConfigDir();
  }
  return baseConfigDir;
}

/**
 * Resolve the current native Claude Code config directory.
 * @returns Absolute `CLAUDE_CONFIG_DIR`, or native `~/.claude` when unset.
 */
function resolveNativeClaudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return configured === undefined ? path.join(os.homedir(), '.claude') : path.resolve(configured);
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

/**
 * Link the lease's `projects/` transcript store to a durable directory.
 *
 * Claude Code writes conversation transcripts to
 * `$CLAUDE_CONFIG_DIR/projects/<cwd-derived-dir>/<sessionId>.jsonl` and
 * resolves `--resume`/`--fork-session` against that same store. A transcript
 * written inside the lease would be deleted with it when the connector closes,
 * leaving nothing for a successor lease (rehydration, fork child) to resume.
 * Linking `projects/` out of the lease keeps native session state on the
 * durable side of the lease boundary: every lease of the same config source
 * shares one store.
 * @param sessionDir - Session-scoped config directory (the lease).
 * @param targetStoreDir - Durable directory that owns transcripts.
 * @param platform - Host platform; Windows uses a junction so directory links
 *   need no elevated privilege.
 */
async function linkDurableProjectsStore(
  sessionDir: string,
  targetStoreDir: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const linkPath = path.join(sessionDir, 'projects');
  // Resolve once: a relative target would be created against process.cwd()
  // but dereferenced relative to the link's parent — two different places.
  const resolvedTargetStoreDir = path.resolve(targetStoreDir);
  await fs.mkdir(resolvedTargetStoreDir, { recursive: true });
  // `unlink` never recurses: a stale link is replaced, while a real directory
  // that unexpectedly holds transcripts fails loudly instead of being deleted.
  try {
    await fs.unlink(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.symlink(resolvedTargetStoreDir, linkPath, platform === 'win32' ? 'junction' : 'dir');
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

/** Optional dependencies for {@link handleClaudeCodeSessionConfigSetup}. */
export interface ClaudeCodeSessionConfigSetupOptions {
  /**
   * Durable directory that owns the linked `projects/` transcript store.
   *
   * Defaults to `projects/` under the resolved source config directory, so
   * transcripts live beside the auth they were recorded with. Injectable so
   * test harnesses can keep transcripts in a suite-scoped store instead of
   * the operator's real config home.
   */
  projectsStoreDir?: string;
}

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
 *   session-specific service name Claude Code derives from its secure-storage
 *   config identity.
 * - `.credentials.json` — inherited for `full` and `auth-only` on
 *   Linux/Windows, with a Windows copy fallback when symlink creation is
 *   denied.
 * - `.claude.json` — filtered to auth/onboarding keys for `full` and
 *   `auth-only`; when `projectDir` is provided, only the matching folder trust
 *   marker is added. Other project and cache state is not inherited.
 * - `projects/` — linked to the durable transcript store for `full` and
 *   `auth-only`, so native session state survives the lease and stays
 *   resumable from successor leases. `empty` inheritance deliberately owns no
 *   durable state: its transcripts die with the lease.
 *
 * This function is intentionally pure with respect to the bus — it receives
 * the already-validated payload and performs local filesystem/keychain
 * operations without exposing credential material as a bus payload.
 * @param payload - Validated setup-delegation payload carrying `sessionDir`,
 *   `baseConfigDir`, and `platform`
 * @param options - Optional overrides for durable-store placement.
 * @returns Session environment and native-auth materialization status.
 */
export async function handleClaudeCodeSessionConfigSetup(
  payload: SessionConfigSetupRequest,
  options?: ClaudeCodeSessionConfigSetupOptions,
): Promise<SessionConfigSetupResponse> {
  const { sessionDir, baseConfigDir, platform, configInheritance, projectDir } = payload;
  const sourceConfigDir = resolveSourceConfigDir(sessionDir, baseConfigDir);
  let authMaterialized = false;

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
    const credentialResult = await inheritClaudeCodeNativeCredentialsForSession({
      sourceConfigDir,
      sessionDir,
      platform,
    });
    authMaterialized = credentialResult.prepared;
    await inheritAuthState(sourceConfigDir, sessionDir, projectDir);
  } else {
    await fs.writeFile(path.join(sessionDir, 'settings.json'), '{}', 'utf-8');
    await fs.rm(path.join(sessionDir, 'settings.local.json'), { force: true });
    await fs.rm(path.join(sessionDir, '.claude.json'), { force: true });
    if (configInheritance === 'auth-only') {
      const credentialResult = await inheritClaudeCodeNativeCredentialsForSession({
        sourceConfigDir,
        sessionDir,
        platform,
      });
      authMaterialized = credentialResult.prepared;
      await inheritAuthState(sourceConfigDir, sessionDir, projectDir);
    } else {
      await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform });
    }
  }

  if (configInheritance !== 'empty') {
    await linkDurableProjectsStore(
      sessionDir,
      options?.projectsStoreDir ?? path.join(sourceConfigDir, 'projects'),
      platform,
    );
  }

  await handleClaudeCodeConfigPrime({
    clientId: 'claude-code',
    configDir: sessionDir,
    phase: 'session-create',
    ...(projectDir !== undefined ? { projectDir } : {}),
  });

  return {
    env: {
      CLAUDE_CONFIG_DIR: sessionDir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: sessionDir,
      // A lease that materializes credentials must also publish the environment
      // needed to read them back. Keychain entries for an isolated store are
      // keyed by this account, and the binary resolves it from USER alone —
      // without it, auth fails with "Not logged in" against a store that
      // demonstrably holds valid credentials.
      //
      // This is an identity selector, not a credential: it names the account a
      // Keychain entry was written under and never carries secret material, so
      // the whole map stays safe to return across the bus. Every consumer must
      // deliver it verbatim — a consumer that re-declares which keys it accepts
      // silently reverts this fix and lets the child fall back to ambient USER.
      ...(platform === 'darwin' && authMaterialized ? { USER: resolveKeychainAccount() } : {}),
    },
    authMaterialized,
  };
}
