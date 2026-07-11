/**
 * Service for `client.sessionConfig.*` ephemeral session directory lifecycle.
 *
 * Manages connector-scoped config leases: creating a temporary working
 * directory seeded from a named profile, tearing it down when its connector
 * closes, releasing every lease owned by a closed framework session, and
 * bulk-cleaning stale lease directories that outlived their process.
 *
 * Filesystem layout:
 * ```
 * {clientsBasePath}/{clientId}/sessions/{leaseId}/
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
  SessionConfigLeaseIdSchema,
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
type SessionConfigSetupPayload = RequestMessagePayload<SessionConfigSetupRequest, SessionConfigSetupResponse>;

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
 * @param leaseId - Candidate config lease ID path component.
 * @param operation - Operation name used in error messages.
 * @returns Resolved absolute session directory path.
 */
function resolveSessionDir(sessionsDir: string, leaseId: string, operation: string): string {
  const parsed = SessionConfigLeaseIdSchema.safeParse(leaseId);
  if (!parsed.success) {
    throw new Error(`${operation} received an unsafe lease ID`);
  }
  const resolvedBase = path.resolve(sessionsDir);
  const resolvedSessionDir = path.resolve(resolvedBase, parsed.data);
  const relative = path.relative(resolvedBase, resolvedSessionDir);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolvedSessionDir;
  }
  throw new Error(`${operation} refused to access path outside client sessions root`);
}

/** One live connector config lease tracked for cleanup. */
interface LiveConfigLease {
  /** Canonical client identifier that owns the lease directory. */
  readonly clientId: string;
  /** Connector-unique lease identity and directory name. */
  readonly leaseId: string;
  /** Optional framework session used only for bulk cleanup. */
  readonly ownerSessionId?: string;
  /** Current lifecycle phase for this exact lease generation. */
  state: 'creating' | 'ready' | 'releasing' | 'released';
  /** Whether release arrived before creation finished. */
  releaseRequested: boolean;
  /** Resolves only after create success or rollback has completely settled. */
  readonly creationSettled: Promise<void>;
  /** Resolve the creation settlement gate exactly once. */
  readonly settleCreation: () => void;
  /** The single cleanup operation owned by this lease generation. */
  releasePromise?: Promise<void>;
}

/**
 * Handles `client.sessionConfig.*` bus subjects, providing leased config
 * directory isolation for client processes.
 */
export class ClientSessionConfigService extends BaseService {
  private readonly liveLeasesByClient = new Map<string, Map<string, LiveConfigLease>>();
  private readonly liveLeasesByOwner = new Map<string, Set<LiveConfigLease>>();

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
    this.registerCreateHandler();

    this.registerHandler(ClientSubjects.sessionConfig.destroy, async (ctx) => {
      const { clientId, leaseId } = ctx.payload;
      const canonicalId = canonicalizeClientId(clientId, 'sessionConfig.destroy');
      const sessionDir = this.resolveClientSessionDir(canonicalId, leaseId, 'sessionConfig.destroy');
      const lease = this.getLiveLease(canonicalId, leaseId);
      if (lease === undefined) {
        await this.destroyClientSessionDir(canonicalId, sessionDir);
      } else {
        await this.releaseLiveLease(lease);
      }
      ctx.setResult({ success: true });
    });

    this.registerHandler(ClientSubjects.sessionConfig.cleanup, async (ctx) => {
      const { clientId } = ctx.payload;
      const canonicalId = clientId !== undefined ? canonicalizeClientId(clientId, 'sessionConfig.cleanup') : undefined;
      const removed = await this.cleanupOrphanedDirs(canonicalId);
      ctx.setResult({ removed });
    });

    this.registerHandler(SessionSubjects.closed, async (ctx) => {
      await this.destroyOwnedLeases(ctx.payload.sessionId);
    });

    // Remove any stale session directories left over from a previous process.
    await this.cleanupOrphanedDirs();
  }

  /** Register the config-lease creation handler and its rollback lifecycle. */
  private registerCreateHandler(): void {
    this.registerHandler(ClientSubjects.sessionConfig.create, async (ctx) => {
      const {
        clientId,
        leaseId,
        ownerSessionId,
        profileName,
        baseConfigDir: explicitBaseConfigDir,
        projectDir,
        configInheritance = 'full',
      } = ctx.payload;
      const canonicalId = canonicalizeClientId(clientId, 'sessionConfig.create');

      const sessionDir = this.resolveClientSessionDir(canonicalId, leaseId, 'sessionConfig.create');
      const lease = this.reserveLiveLease({
        clientId: canonicalId,
        leaseId,
        ...(ownerSessionId !== undefined ? { ownerSessionId } : {}),
      });

      try {
        await fs.mkdir(sessionDir, { recursive: true });
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
        const authMaterialized = setupResult.handled ? setupResult.data.authMaterialized : false;

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

        if (lease.releaseRequested) {
          throw new Error(`Config lease '${leaseId}' was released while it was being created`);
        }
        ctx.setResult({ sessionDir, env, authMaterialized });
        lease.state = 'ready';
      } catch (error) {
        try {
          await this.beginLeaseCleanup(lease);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Client session config creation and rollback both failed');
        }
        throw error;
      } finally {
        lease.settleCreation();
        if (lease.state === 'released') {
          this.untrackLiveLease(lease);
        }
      }
    });
  }

  /**
   * Resolve the base configuration directory for a config lease.
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
            if (!SessionConfigLeaseIdSchema.safeParse(entry).success) {
              return;
            }
            const entryPath = resolveSessionDir(sessionsDir, entry, 'sessionConfig.cleanup');
            let stat: Awaited<ReturnType<typeof fs.stat>>;
            try {
              stat = await fs.stat(entryPath);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === 'ENOENT' || code === 'ENOTDIR') {
                return;
              }
              throw error;
            }
            // Use birthtimeMs (directory creation time) as the age signal so
            // that writing files into the session directory does not reset the
            // clock.  Fall back to ctimeMs on Linux filesystems that report
            // birthtimeMs as 0.
            const createdAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
            if (stat.isDirectory() && now - createdAt > SESSION_MAX_AGE_MS && !this.isLiveLease(id, entry)) {
              await this.destroyClientSessionDir(id, entryPath);
              removed.push(entryPath);
            }
          }),
        );
      }),
    );

    return removed;
  }

  /**
   * Release every live config lease owned by a closed framework session.
   * @param ownerSessionId - Framework session ID from `session.closed`.
   */
  private async destroyOwnedLeases(ownerSessionId: string): Promise<void> {
    const leases = [...(this.liveLeasesByOwner.get(ownerSessionId) ?? [])];
    const results = await Promise.allSettled(
      leases.map(async (lease) => {
        if (this.getLiveLease(lease.clientId, lease.leaseId) === lease) {
          await this.releaseLiveLease(lease);
        }
      }),
    );
    const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to release config leases owned by session '${ownerSessionId}'`);
    }
  }

  /**
   * Run client-owned session config teardown before removing the directory.
   * @param clientId - Canonical client identifier.
   * @param sessionDir - Absolute session config directory to destroy.
   */
  private async destroyClientSessionDir(clientId: string, sessionDir: string): Promise<void> {
    try {
      await this.bus.requestOptional(createClientSessionConfigTeardownSubjectDef(clientId), {
        sessionDir,
        platform: resolveSessionConfigPlatform(),
      });
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  }

  /**
   * Check whether a stale-looking directory belongs to a live config lease.
   * @param clientId - Canonical client identifier.
   * @param leaseId - Lease directory name.
   * @returns `true` when the service still tracks the connector lease.
   */
  private isLiveLease(clientId: string, leaseId: string): boolean {
    return this.getLiveLease(clientId, leaseId) !== undefined;
  }

  /**
   * Get the currently registered generation for a lease coordinate.
   * @param clientId - Canonical client identifier.
   * @param leaseId - Connector-unique config lease ID.
   * @returns Current lease generation, or `undefined` when none is reserved.
   */
  private getLiveLease(clientId: string, leaseId: string): LiveConfigLease | undefined {
    return this.liveLeasesByClient.get(clientId)?.get(leaseId);
  }

  /**
   * Resolve a session directory for a canonical client ID.
   * @param clientId - Canonical client identifier.
   * @param leaseId - Connector-unique config lease ID.
   * @param operation - Operation name used in error messages.
   * @returns Absolute session directory path.
   */
  private resolveClientSessionDir(clientId: string, leaseId: string, operation: string): string {
    return resolveSessionDir(path.join(this.clientsBasePath, clientId, 'sessions'), leaseId, operation);
  }

  /**
   * Atomically reserve a lease in both the client-primary and optional owner indexes.
   * @param identity - Lease identity to reserve before materialization starts.
   * @returns Newly reserved lease generation.
   */
  private reserveLiveLease(
    identity: Pick<LiveConfigLease, 'clientId' | 'leaseId' | 'ownerSessionId'>,
  ): LiveConfigLease {
    if (this.isLiveLease(identity.clientId, identity.leaseId)) {
      throw new Error(`Config lease '${identity.leaseId}' is already active for client '${identity.clientId}'`);
    }

    const creation = Promise.withResolvers<void>();
    const lease: LiveConfigLease = {
      ...identity,
      state: 'creating',
      releaseRequested: false,
      creationSettled: creation.promise,
      settleCreation: () => creation.resolve(),
    };
    const clientLeases = this.liveLeasesByClient.get(lease.clientId) ?? new Map<string, LiveConfigLease>();
    clientLeases.set(lease.leaseId, lease);
    this.liveLeasesByClient.set(lease.clientId, clientLeases);

    if (lease.ownerSessionId !== undefined) {
      const ownerLeases = this.liveLeasesByOwner.get(lease.ownerSessionId) ?? new Set<LiveConfigLease>();
      ownerLeases.add(lease);
      this.liveLeasesByOwner.set(lease.ownerSessionId, ownerLeases);
    }
    return lease;
  }

  /**
   * Release one lease generation, waiting for in-flight creation when needed.
   * @param lease - Exact reservation generation to release.
   */
  private async releaseLiveLease(lease: LiveConfigLease): Promise<void> {
    if (this.getLiveLease(lease.clientId, lease.leaseId) !== lease) {
      if (lease.releasePromise !== undefined) {
        await lease.releasePromise;
      }
      return;
    }
    lease.releaseRequested = true;
    if (lease.state === 'creating') {
      await lease.creationSettled;
      if (lease.releasePromise !== undefined) {
        await lease.releasePromise;
      }
      return;
    }
    await this.beginLeaseCleanup(lease);
  }

  /**
   * Start or join the single cleanup operation for a lease generation.
   * @param lease - Exact reservation generation whose resources must be removed.
   * @returns Shared cleanup promise for this generation.
   */
  private beginLeaseCleanup(lease: LiveConfigLease): Promise<void> {
    if (lease.releasePromise !== undefined) {
      return lease.releasePromise;
    }
    if (this.getLiveLease(lease.clientId, lease.leaseId) !== lease) {
      return Promise.resolve();
    }

    const cleanupStartedDuringCreation = lease.state === 'creating';
    lease.state = 'releasing';
    const sessionDir = this.resolveClientSessionDir(lease.clientId, lease.leaseId, 'sessionConfig.release');
    lease.releasePromise = this.destroyClientSessionDir(lease.clientId, sessionDir).finally(() => {
      lease.state = 'released';
      if (!cleanupStartedDuringCreation) {
        this.untrackLiveLease(lease);
      }
    });
    return lease.releasePromise;
  }

  /**
   * Remove an exact lease generation from both indexes. Stale generations are a no-op.
   * @param lease - Exact reservation generation to remove.
   */
  private untrackLiveLease(lease: LiveConfigLease): void {
    const clientLeases = this.liveLeasesByClient.get(lease.clientId);
    if (clientLeases?.get(lease.leaseId) !== lease) {
      return;
    }

    clientLeases.delete(lease.leaseId);
    if (clientLeases.size === 0) {
      this.liveLeasesByClient.delete(lease.clientId);
    }

    if (lease.ownerSessionId !== undefined) {
      const ownerLeases = this.liveLeasesByOwner.get(lease.ownerSessionId);
      ownerLeases?.delete(lease);
      if (ownerLeases?.size === 0) {
        this.liveLeasesByOwner.delete(lease.ownerSessionId);
      }
    }
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
