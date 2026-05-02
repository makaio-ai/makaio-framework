/**
 * Event handlers for adapter session lifecycle events.
 *
 * Handles adapter domain events and coordinates with storage subjects.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionSubjects,
  SessionDiscoveredSchema,
  type SessionDiscovered,
  type SessionLineage,
  type SessionLineageKind,
} from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { AdapterSessionStorageSubjects, type CreateAndLinkMetadata } from './namespace.js';
import { kindToBranchKind } from './lineage-utils.js';

/**
 * Parameters for the unified session creation and linking helper.
 */
export interface CreateAndLinkParams {
  /** Bus instance for storage writes and lifecycle emissions. */
  bus: IMakaioBus;
  /** Adapter-specific session identifier. */
  adapterSessionId: string;
  /** Adapter type name (e.g., 'claude-code'). */
  adapterName: string;
  /** Adapter instance ID (machine/installation specific). */
  adapterId: string;
  /** Session metadata from the adapter. */
  metadata: CreateAndLinkMetadata;
  /** Existing Makaio sessionId to reuse (e.g., from discovery stub). */
  existingSessionId?: string;
}

/**
 * Result returned from {@link createAndLinkImportedSession}.
 */
export interface CreateAndLinkResult {
  /** The Makaio session ID (either newly created or pre-existing). */
  sessionId: string;
  /** Whether a new session record was created during this call. */
  created: boolean;
}

/**
 * Convert lineage-aware adapter metadata into the canonical create/link metadata shape.
 * @param params - Lineage and optional session metadata from discovery/import.
 * @returns Canonical metadata object for `createAndLinkImportedSession`.
 */
function toImportedSessionMetadata(params: {
  kind: Exclude<SessionLineageKind, 'root'> | null;
  parentAdapterSessionId: string | null;
  forkPointMessageId: string | null;
  model: string | null | undefined;
  cwd: string | null | undefined;
  title: string | null | undefined;
}): CreateAndLinkMetadata {
  const base = {
    model: params.model ?? null,
    cwd: params.cwd ?? null,
    title: params.title ?? null,
  };

  switch (params.kind) {
    case 'fork':
      if (!params.parentAdapterSessionId || !params.forkPointMessageId) {
        throw new Error('Fork session metadata requires parentAdapterSessionId and forkPointMessageId');
      }
      return {
        ...base,
        kind: 'fork',
        parentAdapterSessionId: params.parentAdapterSessionId,
        forkPointMessageId: params.forkPointMessageId,
      };
    case 'subagent':
      if (!params.parentAdapterSessionId) {
        throw new Error('Subagent session metadata requires parentAdapterSessionId');
      }
      return {
        ...base,
        kind: 'subagent',
        parentAdapterSessionId: params.parentAdapterSessionId,
        forkPointMessageId: null,
      };
    case 'compress':
      if (!params.parentAdapterSessionId) {
        throw new Error('Compress session metadata requires parentAdapterSessionId');
      }
      return {
        ...base,
        kind: 'compress',
        parentAdapterSessionId: params.parentAdapterSessionId,
        forkPointMessageId: null,
      };
    case null:
      return {
        ...base,
        kind: null,
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      };
    default:
      return assertUnreachable(params.kind);
  }
}

/**
 * Delete a newly-created session when downstream linking fails.
 * @param bus - Bus used to invoke session deletion.
 * @param sessionCreated - Whether this flow created the session record.
 * @param sessionId - Session identifier to delete when cleanup is required.
 */
async function cleanupSessionIfCreated(bus: IMakaioBus, sessionCreated: boolean, sessionId: string): Promise<void> {
  if (!sessionCreated) {
    return;
  }
  await bus.request(SessionStorageSubjects.delete, { sessionId });
}

/** Resolved lineage context for a session being created. */
interface ResolvedLineage {
  parentSessionId: string | undefined;
  rootSessionId: string | undefined;
}

/**
 * Resolve the Makaio parent and root session IDs from the adapter session chain.
 *
 * Performs eager lookup: if the parent adapter session is already linked to a Makaio
 * session, that `sessionId` becomes `parentSessionId`. If not yet linked, both values
 * are `undefined` (the parent-resolver backfills them later).
 * @param bus - Bus instance for storage lookups.
 * @param parentAdapterSessionId - Parent adapter session ID to resolve.
 * @returns Resolved parentSessionId and rootSessionId (both undefined when parent is not yet linked).
 */
async function resolveLineage(bus: IMakaioBus, parentAdapterSessionId: string | null): Promise<ResolvedLineage> {
  if (!parentAdapterSessionId) {
    return { parentSessionId: undefined, rootSessionId: undefined };
  }

  const { session: parentAdapterSession } = await bus.request(AdapterSessionStorageSubjects.get, {
    adapterSessionId: parentAdapterSessionId,
  });
  const parentSessionId = parentAdapterSession?.sessionId ?? undefined;

  if (!parentSessionId) {
    return { parentSessionId: undefined, rootSessionId: undefined };
  }

  const { session: parentSession } = await bus.request(SessionStorageSubjects.get, { sessionId: parentSessionId });
  return { parentSessionId, rootSessionId: parentSession?.rootSessionId ?? parentSessionId };
}

/**
 * Fill in missing imported-session metadata when a later ingestion path provides richer data.
 *
 * Upload-first imports can create a linked session before discovery contributes title or
 * timestamp metadata. This helper keeps the linked session convergent by filling only missing fields,
 * avoiding overrides of data the user or another workflow may have already set.
 * @param bus - Bus instance for session reads and writes.
 * @param sessionId - Linked Makaio session to enrich.
 * @param metadata - Newly available adapter metadata.
 */
async function enrichLinkedSessionMetadata(
  bus: IMakaioBus,
  sessionId: string,
  metadata: Pick<CreateAndLinkParams['metadata'], 'cwd' | 'title'> & { startedAt?: number },
): Promise<void> {
  const { session } = await bus.request(SessionStorageSubjects.get, { sessionId });
  if (!session) {
    return;
  }

  const updatePayload: {
    sessionId: string;
    title?: string;
    targetWorkingDirectory?: string;
    createdAt?: number;
    lastActivityAt?: number;
  } = {
    sessionId,
  };

  if (metadata.title && !session.title) {
    updatePayload.title = metadata.title;
  }
  if (metadata.cwd && !session.targetWorkingDirectory) {
    updatePayload.targetWorkingDirectory = metadata.cwd;
  }
  if (metadata.startedAt !== undefined && metadata.startedAt < session.createdAt) {
    updatePayload.createdAt = metadata.startedAt;
    // Only rewind lastActivityAt when the linked session still looks like the
    // untouched discovery/upload stub. Once real activity advanced it, preserve it.
    if (session.lastActivityAt === session.createdAt) {
      updatePayload.lastActivityAt = metadata.startedAt;
    }
  }

  if (Object.keys(updatePayload).length === 1) {
    return;
  }

  await bus.request(SessionStorageSubjects.update, updatePayload);
}

/**
 * Link the adapter session to a Makaio session, emit the created event, and guard against races.
 *
 * Handles the race-condition check, linking, event emission, and cleanup on failure.
 * @param bus - Bus instance for storage writes and event emission.
 * @param adapterSessionId - Adapter session to link.
 * @param sessionId - Makaio session to link to.
 * @param sessionCreated - Whether this call created the session record (governs cleanup).
 * @param lineage - Resolved parent/root session identifiers for the created event.
 * @param kind - Lineage kind for the created event.
 * @param createdAt - Creation timestamp for the created event.
 * @returns Whether the link was established and should be considered a new creation.
 */
async function linkAndEmit(
  bus: IMakaioBus,
  adapterSessionId: string,
  sessionId: string,
  sessionCreated: boolean,
  lineage: ResolvedLineage,
  kind: SessionLineageKind | null,
  createdAt: number,
): Promise<boolean> {
  // Race-condition guard: re-check for a concurrent link after session creation.
  const { session: latestAdapterSession } = await bus.request(AdapterSessionStorageSubjects.get, { adapterSessionId });
  if (latestAdapterSession?.sessionId && latestAdapterSession.sessionId !== sessionId) {
    await cleanupSessionIfCreated(bus, sessionCreated, sessionId);
    return false;
  }

  const { success: linked } = await bus.request(AdapterSessionStorageSubjects.linkSession, {
    adapterSessionId,
    sessionId,
  });

  if (!linked) {
    await cleanupSessionIfCreated(bus, sessionCreated, sessionId);
    return false;
  }

  const branchKind = kindToBranchKind(kind ?? 'root');

  await bus.emit(SessionSubjects.created, {
    sessionId,
    createdAt,
    parentSessionId: lineage.parentSessionId ?? null,
    branchKind: branchKind ?? null,
  });

  return true;
}

/**
 * Unified helper that creates and links a Makaio session for an adapter session.
 *
 * Consolidates both the discovery path (`registerSessionDiscoveredHandler`) and the
 * import path into a single authoritative flow:
 *
 * 1. Early-exit if the adapter session is already linked (idempotent).
 * 2. Eagerly resolve `parentSessionId`/`rootSessionId` via `resolveLineage`.
 * 3. Create the Makaio session record via `SessionStorageSubjects.set` with `ifAbsent`.
 * 4. Link, emit `SessionSubjects.created`, and clean up on failure via `linkAndEmit`.
 * @param params - Parameters for the unified session creation/linking flow.
 * @returns The session ID and whether a new record was created.
 */
export async function createAndLinkImportedSession(params: CreateAndLinkParams): Promise<CreateAndLinkResult> {
  const { bus, adapterSessionId, adapterName, adapterId, metadata, existingSessionId } = params;
  const { parentAdapterSessionId, forkPointMessageId, kind, cwd, title } = metadata;

  // Step 1: Early-exit if adapter session is already linked (idempotent).
  const { session: current } = await bus.request(AdapterSessionStorageSubjects.get, { adapterSessionId });
  if (!current) {
    throw new Error(`Adapter session not found for createAndLink: ${adapterSessionId}`);
  }
  if (current?.sessionId) {
    await enrichLinkedSessionMetadata(bus, current.sessionId, {
      cwd: metadata.cwd,
      title: metadata.title,
      startedAt: current.startedAt,
    });
    return { sessionId: current.sessionId, created: false };
  }

  // Step 2: Resolve lineage.
  const lineage = await resolveLineage(bus, parentAdapterSessionId);

  // Step 3: Create the Makaio session record (ifAbsent prevents concurrent overwrites).
  const sessionId = existingSessionId ?? crypto.randomUUID();
  const branchKind = kindToBranchKind(kind ?? 'root');
  // Use the adapter session's startedAt as the stub session timestamp so the
  // session timeline reflects when the external tool actually started.
  // current.startedAt is guaranteed to be a number — AdapterSessionResponseSchema
  // declares it as z.number() (required), and the upsert handler defaults to
  // Date.now() when the optional upsert field is omitted.
  const sessionTimestamp = current.startedAt;

  const { success: sessionCreated } = await bus.request(SessionStorageSubjects.set, {
    sessionId,
    session: {
      sessionId,
      status: 'discovered',
      isImported: true,
      isOrchestrated: false,
      adapterSessionId,
      adapterName,
      adapterId,
      createdAt: sessionTimestamp,
      lastActivityAt: sessionTimestamp,
      agents: [],
      ...(lineage.parentSessionId !== undefined ? { parentSessionId: lineage.parentSessionId } : {}),
      ...(lineage.rootSessionId !== undefined ? { rootSessionId: lineage.rootSessionId } : {}),
      ...(forkPointMessageId ? { forkPointMessageId } : {}),
      ...(branchKind !== undefined ? { branchKind } : {}),
      ...(cwd ? { targetWorkingDirectory: cwd } : {}),
      ...(title ? { title } : {}),
    },
    ifAbsent: true,
  });

  // Step 4: Link, emit created event, and clean up on failure.
  try {
    const linked = await linkAndEmit(bus, adapterSessionId, sessionId, sessionCreated, lineage, kind, sessionTimestamp);
    const resultSessionId = linked
      ? sessionId
      : // Concurrent race: fetch the winning sessionId from the adapter record
        ((await bus.request(AdapterSessionStorageSubjects.get, { adapterSessionId })).session?.sessionId ?? sessionId);
    return { sessionId: resultSessionId, created: linked && sessionCreated };
  } catch (error) {
    // The adapter_session link (linkSession UPDATE) is the commit point.
    // bus.emit(SessionSubjects.created) is fire-and-forget — if it throws,
    // cleanupSessionIfCreated deletes the session row the link points to.
    // A retry will find the stale sessionId via the adapter record and return
    // it, which is the correct idempotent behavior.
    try {
      await cleanupSessionIfCreated(bus, sessionCreated, sessionId);
    } catch (cleanupError) {
      console.error('[createAndLinkImportedSession] Failed to cleanup orphaned session', {
        sessionId,
        adapterSessionId,
        error: cleanupError,
      });
    }
    throw error;
  }
}

/**
 * Register a bus handler for the `createAndLink` subject.
 *
 * Exposes {@link createAndLinkImportedSession} as a bus RPC so cross-package
 * callers (e.g., `@makaio/services-log-import`) can invoke it without a
 * direct import dependency on `@makaio/services-core/session`.
 * @param bus - The bus instance to register the handler on
 * @returns Cleanup function to unsubscribe the handler
 */
export function registerCreateAndLinkHandler(bus: IMakaioBus): () => void {
  return bus.on(AdapterSessionStorageSubjects.createAndLink, async (ctx) => {
    const result = await createAndLinkImportedSession({
      bus,
      ...ctx.payload,
    });
    ctx.setResult(result);
  });
}

/**
 * Enforce exhaustive handling of session lineage kinds.
 * @param value - Unhandled lineage kind
 * @returns Never returns; always throws
 */
function assertUnreachable(value: never): never {
  throw new Error(`Unsupported session lineage kind: ${String(value)}`);
}

/**
 * Build the upsert payload for an adapter session from a discovered event lineage.
 *
 * `SessionDiscovered` is the intersection of `SessionDiscoveredMetadata` and
 * `SessionLineage`, so `payload` already carries the discriminated lineage fields
 * (`kind`, `parentAdapterSessionId`, `forkPointMessageId`) without any additional
 * transformation.
 * @param payload - The discovered session event payload
 * @returns Upsert request payload with discriminated lineage kind
 */
function toDiscoveredUpsertPayload(payload: SessionDiscovered) {
  const {
    adapterSessionId,
    adapterName,
    model,
    cwd,
    logFilePath,
    startedAt,
    kind,
    parentAdapterSessionId,
    forkPointMessageId,
  } = payload;
  const lineage: SessionLineage =
    kind === 'root'
      ? {
          kind,
          parentAdapterSessionId: null,
          forkPointMessageId: null,
        }
      : kind === 'fork'
        ? {
            kind,
            parentAdapterSessionId,
            forkPointMessageId,
          }
        : {
            kind,
            parentAdapterSessionId,
            forkPointMessageId: null,
          };
  return {
    adapterSessionId,
    adapterName,
    model: model ?? null,
    cwd: cwd ?? null,
    // logFilePath ?? null is safe here: the drizzle handler's onConflictDoUpdate
    // uses COALESCE(excluded.log_file_path, existing), so a null incoming value
    // preserves the existing non-null path rather than overwriting it.
    logFilePath: logFilePath ?? null,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...lineage,
  };
}

/**
 * Register handler for adapter.session.discovered events.
 *
 * When a session is discovered from log import:
 * 1. Upsert adapter_sessions record with lineage info and log file path
 * 2. Create and link a Makaio session with all available metadata via the unified helper
 * @param bus - The bus instance to register handlers on
 * @returns Cleanup function to unsubscribe the handler
 */
export function registerSessionDiscoveredHandler(bus: IMakaioBus): () => void {
  return bus.on(AdapterSubjects.session.discovered, async (ctx) => {
    // The bus validates events, but safeParse keeps this handler fail-fast if a
    // transport or test bypasses schema enforcement and delivers malformed data.
    const parsedPayload = SessionDiscoveredSchema.safeParse(ctx.payload);
    if (!parsedPayload.success) {
      console.error('[registerSessionDiscoveredHandler] Invalid adapter.session.discovered payload', {
        issues: parsedPayload.error.issues,
      });
      throw parsedPayload.error;
    }

    const payload = parsedPayload.data;
    const {
      adapterId,
      adapterSessionId,
      adapterName,
      parentAdapterSessionId,
      forkPointMessageId,
      model,
      cwd,
      title,
      kind,
    } = payload;

    // Step 1: Upsert adapter session record with discriminated lineage kind.
    const { sessionId: existingSessionId, created } = await bus.request(
      AdapterSessionStorageSubjects.upsert,
      toDiscoveredUpsertPayload(payload),
    );

    // Step 2: Create and link stub Makaio session only on first discovery or when not yet linked.
    // Route through bus.request so host interceptors (e.g. the adapter session scope
    // interceptor) can fire for live-discovered sessions, matching the behaviour of the
    // log-import path (which already goes through the bus).
    await bus.request(AdapterSessionStorageSubjects.createAndLink, {
      adapterSessionId,
      adapterName,
      adapterId,
      metadata: toImportedSessionMetadata({
        kind: kind === 'root' ? null : kind,
        parentAdapterSessionId,
        forkPointMessageId,
        model,
        cwd,
        title,
      }),
      existingSessionId: created ? undefined : (existingSessionId ?? undefined),
    });
  });
}
