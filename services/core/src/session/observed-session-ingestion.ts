/**
 * Observed-session ingestion — the first production subscriber to the
 * `client.session.*` observed-semantics events.
 *
 * Bridges Hook-Observation into the canonical session model: hook signals
 * provide identity (`client.session.started` → session registration) and
 * cadence (`client.session.turn.completed` → targeted transcript import).
 * Turn boundaries and content always come from the transcript via the
 * log-import service — never from hooks.
 * @packageDocumentation
 */

import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import {
  CapabilitySubjects,
  ClientSubjects,
  FORK_SESSION_LINEAGE_KIND,
  ROOT_SESSION_LINEAGE_KIND,
  SessionRecordMetadataSchema,
  TurnIngestionMarkerSchema,
  type ClientRuntimeStarted,
  type ClientSessionStarted,
  type ClientSessionTurnCompleted,
  type IMakaioSession,
  type SessionRecordMetadata,
} from '@makaio/contracts';
import { SessionStorageSubjects } from './storage/namespace.js';
import {
  OBSERVED_SESSION_INGESTION_POLICY_CAPABILITY_ID,
  type IObservedSessionIngestionPolicyProvider,
  type ObservedSessionIngestionPolicyImportStatus,
  type ObservedSessionIngestionPolicyInput,
} from './observed-session-ingestion-policy.js';

/**
 * Maximum number of adapter session IDs retained in the managed-session gate.
 *
 * Intentionally replicated from the client services (see the identical gate
 * in the Claude Code client service): the gate is fed exclusively by the
 * existing `client.runtime.started` subject — introducing a dedicated
 * "managed session" subject to share the value would violate the
 * no-new-subjects principle of the ingestion design. When the set reaches
 * this cap, the oldest entry is evicted FIFO before a new ID is inserted.
 */
export const MANAGED_SESSION_CAP = 10_000;

/**
 * Minimal local mirror of the log-import bus subjects this component calls.
 *
 * The log-import service package depends on this package, so importing its
 * subject definitions here would create a package cycle. Bus subjects are
 * matched by fully-qualified name and payloads are validated against the
 * schemas registered by the owning service at boot — these mirrored
 * definitions are type carriers for the fields this component reads and
 * writes, not a second source of truth. Canonical schemas live with the
 * log-import service.
 *
 * Exported for tests that stub the log-import seam; not part of the public
 * session API surface.
 * @internal
 */
export const LogImportTriggerSubjects = createBusNamespace('log-import', {
  /** Mirror of `log-import.listImporters` (adapterName/clientId subset). */
  listImporters: {
    request: z.object({}),
    response: z.object({
      /** Registered importers; only the correlation fields are typed here. */
      importers: z.array(
        z.object({
          /** Importer adapter name — the `source` identity used by imports. */
          adapterName: z.string(),
          /** Client application id whose hooks observe this importer's sessions. */
          clientId: z.string().optional(),
        }),
      ),
    }),
  },
  /** Mirror of `log-import.importFile` (path-addressable import trigger). */
  importFile: {
    request: z.object({
      /** Absolute path to the transcript file on disk. */
      filePath: z.string(),
      /** Registered importer adapter name. */
      adapterName: z.string(),
      /** Marker stamped on emitted `session.turn.*` events. */
      ingestionMarker: TurnIngestionMarkerSchema.optional(),
    }),
    response: z.discriminatedUnion('status', [
      z.object({
        /** File was imported and persisted. */
        status: z.literal('imported'),
        /** Makaio session ID that was populated. */
        sessionId: z.string(),
        /** Number of messages persisted. */
        messageCount: z.number(),
        /** Number of turns persisted. */
        turnCount: z.number(),
      }),
      z.object({
        /** Request was gracefully skipped. */
        status: z.literal('skipped'),
        /** Machine-readable skip reason. */
        reason: z.enum(['no-importer', 'file-missing']),
      }),
    ]),
  },
  /** Mirror of `log-import.importSession` (discovery-stub-based trigger). */
  importSession: {
    request: z.object({
      /** External session ID provided by the adapter. */
      adapterSessionId: z.string(),
      /** Registered importer adapter name. */
      adapterName: z.string(),
      /** Marker stamped on emitted `session.turn.*` events. */
      ingestionMarker: TurnIngestionMarkerSchema.optional(),
    }),
    response: z.object({
      /** Makaio session ID that was populated. */
      sessionId: z.string(),
      /** Number of messages imported into the session. */
      messageCount: z.number(),
    }),
  },
}).subjects;

/**
 * Log a debug-level diagnostic when `MAKAIO_DEBUG` is enabled.
 * @param message - Human-readable diagnostic message
 * @param details - Optional structured context
 */
function debugLog(message: string, details?: Record<string, unknown>): void {
  if (process.env['MAKAIO_DEBUG'] !== 'true') return;
  console.debug(`[ObservedSessionIngestion] ${message}`, details ?? {});
}

/**
 * Check whether a capability provider payload implements the observed-session policy.
 * @param provider - Runtime provider payload
 * @returns True when the payload exposes the policy decision method
 */
function isObservedSessionIngestionPolicyProvider(
  provider: unknown,
): provider is IObservedSessionIngestionPolicyProvider {
  if (!provider || typeof provider !== 'object') return false;
  const candidate = provider as Partial<IObservedSessionIngestionPolicyProvider>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.displayName === 'string' &&
    typeof candidate.decideObservedSessionIngestion === 'function'
  );
}

/**
 * Check whether a stored session represents a metadata-only observed session.
 *
 * Plain discovery scans also use `importStatus: 'discovered'`; the client id
 * distinguishes hook-observed metadata-only registrations from scan-discovered
 * sessions that are still eligible for explicit lazy import.
 * @param session - Stored session row
 * @returns True when content import must be suppressed
 */
export function isPolicyDiscoveredObservedSession(session: Pick<IMakaioSession, 'clientId' | 'importStatus'>): boolean {
  return session.importStatus === 'discovered' && session.clientId !== undefined;
}

/**
 * Bridges observed client sessions into the canonical session model.
 *
 * Responsibilities:
 * - Register observed sessions on `client.session.started` through the
 *   unified registration seam (`storage:session.importUpsert`), keyed on the
 *   importer's adapter name so hook-first registration and later transcript
 *   imports converge on the same `(source, adapterSessionId)` identity.
 * - Trigger targeted transcript imports on `client.session.turn.completed`
 *   (`log-import.importFile` when the transcript path is known, discovery
 *   fallback via `log-import.importSession` otherwise).
 * - Suppress all work for adapter-managed sessions: sessions the managed
 *   orchestration path drives already flow through the orchestrator and must
 *   not be double-ingested (gate fed by `client.runtime.started`).
 *
 * Non-responsibilities:
 * - Holds NO turn state — turn boundaries and content come exclusively from
 *   the transcript reconstruction during import (design Principle 4).
 * - Never emits `session.*` subjects itself — the turn lifecycle ingestion
 *   seam is the single emitter (design Principle 2).
 *
 * The component is client-agnostic: client and importer identities come from
 * event payloads and the log-import registry, never from hard-coded client
 * ids. A single subscription per subject on the global `client` namespace
 * covers every emitting client; `clientId` in the payload is the
 * discriminator. When no log-import service or no matching importer is
 * registered (framework-only mode), all work is skipped silently.
 */
export class ObservedSessionIngestionService {
  /**
   * Adapter session IDs owned by the managed orchestration path.
   *
   * FIFO-capped at {@link MANAGED_SESSION_CAP}; insertion order is the
   * eviction order (mirrors the client services' gate).
   */
  private readonly managedAdapterSessionIds = new Set<string>();

  /**
   * Importer resolutions per client id.
   *
   * Importers register at boot and do not un-register mid-session, so this
   * cache (including misses) is valid for the lifetime of the service instance.
   */
  private readonly importerByClientId = new Map<string, string | null>();

  /** Client ids already debug-logged as unresolvable (one log per client id). */
  private readonly unresolvedClientIds = new Set<string>();

  /** Registered optional policy providers; deny/discovered decisions win. */
  private readonly policyProviders = new Map<string, IObservedSessionIngestionPolicyProvider>();

  private readonly cleanups: Array<() => void> = [];

  /**
   * Create the service and subscribe to the observed-session subjects.
   * @param bus - Application bus instance
   */
  public constructor(private readonly bus: IMakaioBus = MakaioBus) {
    this.cleanups.push(
      this.bus.on(ClientSubjects.runtime.started, (ctx) => {
        this.handleRuntimeStarted(ctx.payload);
      }),
      this.bus.on(ClientSubjects.session.started, async (ctx) => {
        try {
          await this.handleSessionStarted(ctx.payload);
        } catch (error) {
          console.warn('[ObservedSessionIngestion] Failed to register observed session', {
            clientId: ctx.payload.clientId,
            adapterSessionId: ctx.payload.adapterSessionId,
            error,
          });
        }
      }),
      // Import triggers fire ONLY on turn.completed — never on turn.started.
      // turn.started is cadence-only: the transcript segment for the turn does
      // not exist yet at that point, so an import trigger would be a no-op.
      this.bus.on(ClientSubjects.session.turn.completed, async (ctx) => {
        try {
          await this.handleTurnCompleted(ctx.payload);
        } catch (error) {
          console.warn('[ObservedSessionIngestion] Failed to trigger import for observed turn', {
            clientId: ctx.payload.clientId,
            adapterSessionId: ctx.payload.adapterSessionId,
            error,
          });
        }
      }),
      this.bus.on(
        CapabilitySubjects.register,
        (ctx) => {
          const { provider } = ctx.payload;
          if (isObservedSessionIngestionPolicyProvider(provider)) {
            this.policyProviders.set(provider.id, provider);
          }
        },
        { filter: { capabilityId: OBSERVED_SESSION_INGESTION_POLICY_CAPABILITY_ID } },
      ),
      this.bus.on(
        CapabilitySubjects.unregister,
        (ctx) => {
          this.policyProviders.delete(ctx.payload.providerId);
        },
        { filter: { capabilityId: OBSERVED_SESSION_INGESTION_POLICY_CAPABILITY_ID } },
      ),
    );
  }

  /** Unsubscribe all bus handlers. */
  public destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
  }

  /**
   * Record adapter-managed sessions in the suppression gate.
   *
   * Unlike the per-client gates inside the client services, this component
   * does not filter by `clientId`: it is client-agnostic, and an adapter
   * session ID marked as managed must suppress observed ingestion regardless
   * of which client runtime reported it. Non-adapter source layers (e.g.
   * `'supervisor'`, `'statusline'`) never suppress — they observe sessions
   * the managed path does not own.
   * @param payload - `client.runtime.started` payload
   */
  private handleRuntimeStarted(payload: ClientRuntimeStarted): void {
    if (payload.source.layer !== 'adapter' || payload.adapterSessionId === undefined) {
      return;
    }
    if (this.managedAdapterSessionIds.has(payload.adapterSessionId)) {
      return;
    }
    if (this.managedAdapterSessionIds.size >= MANAGED_SESSION_CAP) {
      const oldest = this.managedAdapterSessionIds.values().next().value;
      if (oldest !== undefined) {
        this.managedAdapterSessionIds.delete(oldest);
      }
    }
    this.managedAdapterSessionIds.add(payload.adapterSessionId);
  }

  /**
   * Resolve the log-import importer responsible for a client's sessions.
   *
   * Bridges the correlation gap between hook identity and import identity:
   * hooks report the client id (e.g. `'claude-code'`) while the import path
   * keys sessions on the importer's adapter name. Registrations advertise
   * their `clientId` via `log-import.listImporters`.
   *
   * Graceful absence: `null` means framework-only mode (no log-import
   * service, or no importer registered for this client) — callers skip
   * silently. At most one debug log is emitted per unresolved client id.
   * @param clientId - Stable client id from the observed event payload
   * @returns Importer adapter name, or `null` when no importer is registered
   */
  private async resolveImporter(clientId: string): Promise<{ adapterName: string } | null> {
    const cached = this.importerByClientId.get(clientId);
    if (cached !== undefined) {
      return cached === null ? null : { adapterName: cached };
    }
    const result = await this.bus.requestOptional(LogImportTriggerSubjects.listImporters, {});
    if (!result.handled) {
      this.debugUnresolved(clientId, 'no log-import service registered');
      return null;
    }
    const importer = result.data.importers.find((entry) => entry.clientId === clientId);
    if (importer === undefined) {
      this.importerByClientId.set(clientId, null);
      this.debugUnresolved(clientId, 'no importer registered for client');
      return null;
    }
    this.importerByClientId.set(clientId, importer.adapterName);
    return { adapterName: importer.adapterName };
  }

  /**
   * Debug-log an unresolved client id at most once.
   * @param clientId - Client id that could not be resolved to an importer
   * @param reason - Why resolution failed
   */
  private debugUnresolved(clientId: string, reason: string): void {
    if (this.unresolvedClientIds.has(clientId)) return;
    this.unresolvedClientIds.add(clientId);
    debugLog(`Skipping observed ingestion for client '${clientId}': ${reason}`);
  }

  /**
   * Register an observed session through the unified registration seam.
   *
   * Skipped for managed sessions and when no importer is resolvable — a
   * session that can never receive imported content must not create a
   * dangling stub. The registration `source` is the importer's adapter name,
   * NOT the raw client id: the `(source, adapterSessionId)` upsert key must
   * match what the import path writes, otherwise hook-first registration
   * would fork the session identity and every import would create a
   * duplicate session.
   * @param payload - `client.session.started` payload
   */
  private async handleSessionStarted(payload: ClientSessionStarted): Promise<void> {
    const adapterSessionId = payload.adapterSessionId;
    if (adapterSessionId === undefined || adapterSessionId.length === 0) return;
    if (this.managedAdapterSessionIds.has(adapterSessionId)) return;

    const importer = await this.resolveImporter(payload.clientId);
    if (importer === null) return;

    const metadata = parseSessionMetadata(payload.metadata);
    const importStatus = await this.decideImportStatus({
      clientId: payload.clientId,
      source: payload.source,
      adapterSessionId,
      adapterName: importer.adapterName,
      ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
      ...(payload.transcriptPath !== undefined ? { transcriptPath: payload.transcriptPath } : {}),
    });

    // Derive lineage discriminant from the optional fork signal. When the
    // emitter reports startMode === 'fork' with a parent adapter session id,
    // register as a fork child immediately — forkPointMessageId is null at
    // this stage and gets enriched later by the transcript import (fill-once).
    const forkParent =
      payload.startMode === 'fork' &&
      payload.parentAdapterSessionId !== undefined &&
      payload.parentAdapterSessionId.length > 0
        ? payload.parentAdapterSessionId
        : undefined;

    const lineage =
      forkParent !== undefined
        ? {
            kind: FORK_SESSION_LINEAGE_KIND,
            parentAdapterSessionId: forkParent,
            forkPointMessageId: null,
          }
        : {
            kind: ROOT_SESSION_LINEAGE_KIND,
            parentAdapterSessionId: null,
            forkPointMessageId: null,
          };

    const result = await this.bus.requestOptional(SessionStorageSubjects.importUpsert, {
      ...lineage,
      externalSessionId: adapterSessionId,
      source: importer.adapterName,
      clientId: payload.clientId,
      cwd: payload.cwd ?? null,
      ...(payload.transcriptPath !== undefined ? { logFilePath: payload.transcriptPath } : {}),
      ...(payload.machineId !== undefined ? { machineId: payload.machineId } : {}),
      startedAt: payload.observedAt,
      importStatus,
      ...(metadata !== undefined ? { metadata } : {}),
    });
    if (!result.handled) {
      // Session storage not registered yet (boot window / degraded host) —
      // the watcher or a later import re-registers idempotently.
      debugLog('Session storage unavailable; skipped observed-session registration', { adapterSessionId });
    }
  }

  /**
   * Trigger a targeted transcript import for a completed observed turn.
   *
   * Preferred trigger: `log-import.importFile` with the transcript path from
   * the hook payload (no prior discovery stub required). Fallback when the
   * payload carries no path: `log-import.importSession`, which requires an
   * existing discovery stub and throws otherwise — tolerated and
   * debug-logged, because the polling watcher ingests the turn on its next
   * pass either way. If hook payloads prove to lack the transcript path at
   * fire time in practice, resolving the path from the statusline cache is
   * the candidate follow-up seam.
   * @param payload - `client.session.turn.completed` payload
   */
  private async handleTurnCompleted(payload: ClientSessionTurnCompleted): Promise<void> {
    const adapterSessionId = payload.adapterSessionId;
    if (adapterSessionId === undefined || adapterSessionId.length === 0) return;
    if (this.managedAdapterSessionIds.has(adapterSessionId)) return;

    const importer = await this.resolveImporter(payload.clientId);
    if (importer === null) return;

    if (
      !(await this.shouldImportObservedContent({
        clientId: payload.clientId,
        source: payload.source,
        adapterSessionId,
        adapterName: importer.adapterName,
        ...(payload.transcriptPath !== undefined ? { transcriptPath: payload.transcriptPath } : {}),
      }))
    ) {
      return;
    }

    if (payload.transcriptPath !== undefined) {
      const result = await this.bus.requestOptional(LogImportTriggerSubjects.importFile, {
        filePath: payload.transcriptPath,
        adapterName: importer.adapterName,
        ingestionMarker: 'live',
      });
      if (!result.handled) {
        debugLog('log-import.importFile unhandled; watcher fallback will ingest', { adapterSessionId });
      } else if (result.data.status === 'skipped') {
        debugLog('Targeted import skipped', { adapterSessionId, reason: result.data.reason });
      }
      return;
    }

    try {
      await this.bus.requestOptional(LogImportTriggerSubjects.importSession, {
        adapterSessionId,
        adapterName: importer.adapterName,
        ingestionMarker: 'live',
      });
    } catch (error) {
      debugLog('Discovery-based import fallback failed (no stub yet); watcher will ingest', {
        adapterSessionId,
        error,
      });
    }
  }

  /**
   * Evaluate registered policy providers for an observed session.
   *
   * No provider means the current default: content tracking. When multiple
   * providers are present, `discovered` wins so independent policy modules can
   * only restrict content import, not override each other's deny decisions.
   * @param input - Observed session identity and importer context
   * @returns Import status for the registration
   */
  private async decideImportStatus(
    input: ObservedSessionIngestionPolicyInput,
  ): Promise<ObservedSessionIngestionPolicyImportStatus> {
    for (const provider of this.policyProviders.values()) {
      const decision = await provider.decideObservedSessionIngestion(input);
      if (decision.importStatus === 'discovered') {
        return 'discovered';
      }
    }
    return 'tracking';
  }

  /**
   * Determine whether a completed observed turn may trigger content import.
   * @param input - Observed turn identity and importer context
   * @returns True when content import should run
   */
  private async shouldImportObservedContent(input: ObservedSessionIngestionPolicyInput): Promise<boolean> {
    const stored = await this.bus.requestOptional(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: input.adapterSessionId,
      source: input.adapterName,
    });
    if (stored.handled && stored.data.session !== null) {
      if (isPolicyDiscoveredObservedSession(stored.data.session)) {
        return false;
      }
      if (stored.data.session.importStatus !== 'discovered') {
        return true;
      }
    }

    return (await this.decideImportStatus(input)) === 'tracking';
  }
}

/**
 * Validate hook pass-through metadata against the session metadata contract.
 *
 * Hook metadata is arbitrary pass-through from the client adapter; only
 * JSON-safe records are preserved as session metadata (AC14). Invalid
 * payloads are dropped — registration proceeds without metadata.
 * @param metadata - Raw metadata record from the observed event payload
 * @returns Validated metadata, or `undefined` when absent or not JSON-safe
 */
function parseSessionMetadata(metadata: Record<string, unknown> | undefined): SessionRecordMetadata | undefined {
  if (metadata === undefined) return undefined;
  const parsed = SessionRecordMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data : undefined;
}
