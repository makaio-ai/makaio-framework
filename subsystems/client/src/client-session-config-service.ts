/**
 * Service for `client.sessionConfig.*` ephemeral session directory lifecycle.
 *
 * Manages per-session config isolation: creating a temporary working directory
 * seeded from a named profile, tearing it down after a session ends, and
 * bulk-cleaning stale session directories that outlived their process.
 *
 * Filesystem layout:
 * ```
 * {clientsBasePath}/{clientId}/sessions/{sessionId}/
 * ```
 *
 * Setup delegation:
 * After creating the session directory, the service attempts to delegate to the
 * per-client `client:<clientId>.sessionConfig.setup` subject via
 * `requestOptional`.  Clients that register a handler populate the directory
 * with the correct config files and return any environment variables the process
 * should inherit.  When no handler is registered the session directory remains
 * empty and no extra env vars are added.
 * @packageDocumentation
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  ClientSubjects,
  SessionConfigIdSchema,
  type SessionConfigInheritance,
  type SessionConfigSetupRequest,
  type SessionConfigSetupResponse,
  type SessionConfigTeardownRequest,
  type SessionConfigTeardownResponse,
} from '@makaio/contracts/client';
import { SessionSubjects } from '@makaio/contracts/session';
import { BaseService } from '@makaio/service-base';
import type { RequestMessagePayload, SubjectDefinition, SubjectRecord } from '@makaio/core';
import { ClientProfileStorageSubjects } from './storage/profile-storage-namespace.js';
import { canonicalizeClientId } from './client-session-observed-semantics.js';
import { primeClientConfig } from './client-config-prime.js';

// ---------------------------------------------------------------------------
// Per-client sessionConfig.setup subject definition
// ---------------------------------------------------------------------------

/** Payload type for the per-client sessionConfig.setup request/response pair. */
type SessionConfigSetupPayload = RequestMessagePayload<
  {
    /** Absolute path to the isolated session config directory to populate. */
    sessionDir: string;
    /** Absolute path to the profile's base config directory used as the source. */
    baseConfigDir: string;
    /** Project directory the client process will start in, when relevant. */
    projectDir?: string;
    /** Host operating system platform. */
    platform: SessionConfigSetupRequest['platform'];
    /** Policy for inheriting settings and auth from the resolved base config. */
    configInheritance: SessionConfigInheritance;
  },
  SessionConfigSetupResponse
>;

type SessionConfigSetupSubjectRecord = SubjectRecord<'sessionConfig.setup', SessionConfigSetupPayload>;

/**
 * Non-owning typed {@link SubjectDefinition} for `client:<id>.sessionConfig.setup`.
 *
 * Follows the same non-owning pattern as {@link ClientWiringListSubjectDef} —
 * the concrete client package owns the full `client:<id>` namespace while this
 * service dispatches without registering a conflicting namespace.
 */
type ClientSessionConfigSetupSubjectDef = SubjectDefinition<
  SessionConfigSetupSubjectRecord,
  'sessionConfig.setup',
  `client:${string}`
>;

type SessionConfigTeardownPayload = RequestMessagePayload<SessionConfigTeardownRequest, SessionConfigTeardownResponse>;

type SessionConfigTeardownSubjectRecord = SubjectRecord<'sessionConfig.destroy', SessionConfigTeardownPayload>;

type ClientSessionConfigTeardownSubjectDef = SubjectDefinition<
  SessionConfigTeardownSubjectRecord,
  'sessionConfig.destroy',
  `client:${string}`
>;

/**
 * Build a non-owning typed {@link SubjectDefinition} for
 * `client:<clientId>.sessionConfig.setup`.
 *
 * Intentionally **not** a namespace registration.  The concrete client package
 * owns its full `client:<id>` namespace; this service only needs to dispatch the
 * setup request without registering a conflicting namespace.
 * @param clientId - Stable client identifier (e.g. `'claude-code'`), already
 *   canonicalized via {@link canonicalizeClientId}.
 * @returns Non-owning typed subject definition for the per-client setup subject.
 */
function createClientSessionConfigSetupSubjectDef(clientId: string): ClientSessionConfigSetupSubjectDef {
  return {
    subject: 'sessionConfig.setup',
    $meta: {
      namespace: `client:${clientId}`,
      isRequest: true,
      local: false,
      channel: false,
    },
  } as ClientSessionConfigSetupSubjectDef;
}

/**
 * Build a non-owning typed {@link SubjectDefinition} for
 * `client:<clientId>.sessionConfig.destroy`.
 * @param clientId - Stable client identifier, already canonicalized.
 * @returns Non-owning typed subject definition for the per-client teardown subject.
 */
function createClientSessionConfigTeardownSubjectDef(clientId: string): ClientSessionConfigTeardownSubjectDef {
  return {
    subject: 'sessionConfig.destroy',
    $meta: {
      namespace: `client:${clientId}`,
      isRequest: true,
      local: false,
      channel: false,
    },
  } as ClientSessionConfigTeardownSubjectDef;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Maximum age of a session directory before it is considered orphaned. */
const SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Default `getNow` implementation — evaluated lazily via the parameter default.
const defaultGetNow = (): number => Date.now();

/**
 * Resolve the current host platform to the session config contract subset.
 * @returns Platform identifier accepted by client-owned setup/teardown handlers.
 */
function resolveSessionConfigPlatform(): SessionConfigSetupPayload['request']['platform'] {
  const platform = os.platform();
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  throw new Error(`client.sessionConfig does not support platform '${platform}'`);
}

/**
 * Resolve a session directory and verify it remains under the expected root.
 * @param sessionsDir - Absolute directory that owns all session config dirs for a client.
 * @param sessionId - Candidate session ID path component.
 * @param operation - Operation name used in error messages.
 * @returns Resolved absolute session directory path.
 */
function resolveSessionDir(sessionsDir: string, sessionId: string, operation: string): string {
  const parsed = SessionConfigIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new Error(`${operation} received an unsafe session ID`);
  }
  const resolvedBase = path.resolve(sessionsDir);
  const resolvedSessionDir = path.resolve(resolvedBase, parsed.data);
  const relative = path.relative(resolvedBase, resolvedSessionDir);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedSessionDir;
  }
  throw new Error(`${operation} refused to access path outside client sessions root`);
}

/**
 * Handles `client.sessionConfig.*` bus subjects, providing per-session config
 * directory isolation for client processes.
 */
export class ClientSessionConfigService extends BaseService {
  /**
   * @param bus - Bus instance used for handler registration and storage requests
   * @param clientsBasePath - Absolute path to the top-level clients directory
   *   (e.g. `~/.makaio/clients/`)
   * @param getNow - Returns the current Unix epoch in milliseconds; injectable
   *   for deterministic testing (defaults to `Date.now`)
   */
  public constructor(
    bus: IMakaioBus,
    private readonly clientsBasePath: string,
    private readonly getNow: () => number = defaultGetNow,
  ) {
    super(bus);
  }

  /**
   * Register all `client.sessionConfig.*` handlers and run boot-time cleanup.
   */
  protected override async onInit(): Promise<void> {
    this.registerHandler(ClientSubjects.sessionConfig.create, async (ctx) => {
      const {
        clientId,
        sessionId,
        profileName,
        baseConfigDir: explicitBaseConfigDir,
        projectDir,
        configInheritance = 'full',
      } = ctx.payload;
      const canonicalId = canonicalizeClientId(clientId, 'sessionConfig.create');

      const sessionDir = this.resolveClientSessionDir(canonicalId, sessionId, 'sessionConfig.create');
      await fs.mkdir(sessionDir, { recursive: true });

      try {
        const baseConfigDir = await this.resolveBaseConfigDir(
          canonicalId,
          sessionDir,
          profileName,
          explicitBaseConfigDir,
        );

        // Delegate setup to the client-owned handler.  NoHandlerError is expected
        // and silently ignored — the session directory remains empty.
        const setupSubject = createClientSessionConfigSetupSubjectDef(canonicalId);
        const setupResult = await this.bus.requestOptional(setupSubject, {
          sessionDir,
          baseConfigDir,
          projectDir,
          platform: resolveSessionConfigPlatform(),
          configInheritance,
        });

        const env = setupResult.handled ? (setupResult.data.env ?? {}) : {};

        // Prime the session config directory after setup delegation.  The call is
        // blocking so that config writes complete before the session directory
        // path is returned to the caller.  The call is a no-op when the client
        // has not registered a handler.
        await primeClientConfig(this.bus, {
          clientId: canonicalId,
          configDir: sessionDir,
          phase: 'session-create',
          projectDir,
        });

        ctx.setResult({ sessionDir, env });
      } catch (error) {
        await fs.rm(sessionDir, { recursive: true, force: true });
        throw error;
      }
    });

    this.registerHandler(ClientSubjects.sessionConfig.destroy, async (ctx) => {
      const { clientId, sessionId } = ctx.payload;
      const canonicalId = canonicalizeClientId(clientId, 'sessionConfig.destroy');
      const sessionDir = this.resolveClientSessionDir(canonicalId, sessionId, 'sessionConfig.destroy');
      await this.destroyClientSessionDir(canonicalId, sessionDir);
      ctx.setResult({ success: true });
    });

    this.registerHandler(ClientSubjects.sessionConfig.cleanup, async (ctx) => {
      const { clientId } = ctx.payload;
      const canonicalId = clientId !== undefined ? canonicalizeClientId(clientId, 'sessionConfig.cleanup') : undefined;
      const removed = await this.cleanupOrphanedDirs(canonicalId);
      ctx.setResult({ removed });
    });

    this.registerHandler(SessionSubjects.closed, async (ctx) => {
      await this.destroySessionDirsForSessionId(ctx.payload.sessionId);
    });

    // Remove any stale session directories left over from a previous process.
    await this.cleanupOrphanedDirs();
  }

  /**
   * Resolve the base configuration directory for a session.
   *
   * Resolution order:
   * 1. Explicit `baseConfigDir` from the request payload.
   * 2. Named profile's `configDir` looked up via storage.
   * 3. Default profile's `configDir` when no explicit name was provided.
   * 4. `sessionDir` — the client-owned setup handler decides the actual source
   *    (e.g. `~/.claude` for Claude Code) when no profile is configured.
   * @param clientId - Canonicalized stable client identifier
   * @param sessionDir - Absolute path to the already-created session directory
   * @param profileName - Optional profile name to look up
   * @param explicitBaseConfigDir - Caller-supplied override, if any
   * @returns Resolved absolute path for the base config directory
   */
  private async resolveBaseConfigDir(
    clientId: string,
    sessionDir: string,
    profileName: string | undefined,
    explicitBaseConfigDir: string | undefined,
  ): Promise<string> {
    if (explicitBaseConfigDir !== undefined) {
      return explicitBaseConfigDir;
    }

    if (profileName !== undefined) {
      const result = await this.bus.request(ClientProfileStorageSubjects.get, {
        clientId,
        name: profileName,
      });
      if (result.record !== null) {
        return result.record.configDir;
      }
      throw new Error(`Profile '${profileName}' not found for client '${clientId}'`);
    }

    // Check for a default profile when no explicit profile name was provided.
    const listResult = await this.bus.request(ClientProfileStorageSubjects.list, { clientId });
    const defaultProfile = listResult.records.find((r) => r.isDefault);
    if (defaultProfile) {
      return defaultProfile.configDir;
    }

    // No profile found — pass sessionDir so the client-owned setup handler can
    // apply its own native fallback (e.g. ~/.claude for Claude Code).
    return sessionDir;
  }

  /**
   * Scan session directories and remove those older than {@link SESSION_MAX_AGE_MS}.
   *
   * When `clientId` is supplied only that client's sessions are scanned.
   * Omit it to clean across all clients.
   * @param clientId - Optional client ID to scope cleanup
   * @returns Absolute paths of all directories that were removed
   */
  private async cleanupOrphanedDirs(clientId?: string): Promise<string[]> {
    const removed: string[] = [];
    const now = this.getNow();

    const clientIds = clientId !== undefined ? [clientId] : await this.listClientIds();

    await Promise.all(
      clientIds.map(async (id) => {
        const sessionsDir = path.join(this.clientsBasePath, id, 'sessions');
        const entries = await fs.readdir(sessionsDir).catch(() => [] as string[]);

        await Promise.all(
          entries.map(async (entry) => {
            try {
              const entryPath = resolveSessionDir(sessionsDir, entry, 'sessionConfig.cleanup');
              const stat = await fs.stat(entryPath);
              // Use birthtimeMs (directory creation time) as the age signal so
              // that writing files into the session directory does not reset the
              // clock.  Fall back to ctimeMs on Linux filesystems that report
              // birthtimeMs as 0.
              const createdAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
              if (stat.isDirectory() && now - createdAt > SESSION_MAX_AGE_MS && !(await this.isActiveSession(entry))) {
                await this.destroyClientSessionDir(id, entryPath);
                removed.push(entryPath);
              }
            } catch {
              // Directory disappeared between readdir and stat — ignore.
            }
          }),
        );
      }),
    );

    return removed;
  }

  /**
   * Remove every per-client config directory for a closed framework session.
   * @param sessionId - Framework session ID from `session.closed`.
   */
  private async destroySessionDirsForSessionId(sessionId: string): Promise<void> {
    if (!SessionConfigIdSchema.safeParse(sessionId).success) {
      return;
    }

    const clientIds = await this.listClientIds();
    await Promise.all(
      clientIds.map(async (clientId) => {
        const sessionDir = this.resolveClientSessionDir(clientId, sessionId, 'session.closed');
        await this.destroyClientSessionDir(clientId, sessionDir);
      }),
    );
  }

  /**
   * Run client-owned session config teardown before removing the directory.
   * @param clientId - Canonical client identifier.
   * @param sessionDir - Absolute session config directory to destroy.
   */
  private async destroyClientSessionDir(clientId: string, sessionDir: string): Promise<void> {
    const exists = await fs.stat(sessionDir).then(
      (stat) => stat.isDirectory(),
      (error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw error;
      },
    );
    if (!exists) {
      return;
    }

    await this.bus.requestOptional(createClientSessionConfigTeardownSubjectDef(clientId), {
      sessionDir,
      platform: resolveSessionConfigPlatform(),
    });
    await fs.rm(sessionDir, { recursive: true, force: true });
  }

  /**
   * Check whether a stale-looking directory belongs to a still-active session.
   * @param sessionId - Session directory name.
   * @returns `true` when the session registry still marks the session active.
   */
  private async isActiveSession(sessionId: string): Promise<boolean> {
    const result = await this.bus.requestOptional(SessionSubjects.get, { sessionId });
    return result.handled && result.data.session?.status === 'active';
  }

  /**
   * Resolve a session directory for a canonical client ID.
   * @param clientId - Canonical client identifier.
   * @param sessionId - Framework session ID.
   * @param operation - Operation name used in error messages.
   * @returns Absolute session directory path.
   */
  private resolveClientSessionDir(clientId: string, sessionId: string, operation: string): string {
    return resolveSessionDir(path.join(this.clientsBasePath, clientId, 'sessions'), sessionId, operation);
  }

  /**
   * List all client IDs that currently have a directory under `clientsBasePath`.
   * @returns Array of directory names (one per client)
   */
  private async listClientIds(): Promise<string[]> {
    const entries = await fs.readdir(this.clientsBasePath, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }
}
