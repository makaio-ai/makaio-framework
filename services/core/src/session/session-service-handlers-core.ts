import { createHash } from 'node:crypto';
import { TimeoutError, type IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type IMakaioSession } from '@makaio/contracts';
import { TurnStorageSubjects } from '../turn/namespace.js';
import { SessionEventStorageSubjects } from './session-events/namespace.js';
import { SessionStorageSubjects } from './storage/namespace.js';
import { AgentStorageSubjects } from './storage/agent-namespace.js';
import { registerAgentAddedHandler, registerAgentRemovedHandler } from './session-service-agent-handlers.js';
import { recoverAgent } from './utils/agent-recovery.js';

/**
 * Dependencies required to register the framework-core session service handlers.
 *
 * Intentionally minimal — no `contextTracker` or host-layer concerns.
 * Host-specific handlers (search, resume, context window, etc.) are registered
 * separately via the host session service.
 */
interface CoreSessionServiceHandlerDeps {
  /** The event bus used for handler registration and storage dispatch. */
  bus: IMakaioBus;
}

/**
 * Registers the framework-core session service handlers:
 * `session.create`, `session.get`, `session.list`, `session.turn.await`,
 * `session.close`, `session.restartAgents`, `session.update`,
 * `session.archive`, `session.purge`, `session.registerExternal`,
 * `session.agent.added`, and `session.agent.removed`.
 *
 * These handlers cover the minimal, load-bearing session contract for the
 * framework SDK. Host-specific handlers (search, resume, analytics, context
 * window) are registered by the host session service at a higher priority.
 *
 * Persistence degrades gracefully when no storage handlers are registered:
 * `session.get` / `session.list` / `session.close` all delegate to
 * `SessionStorageSubjects.*` which may be unhandled in ephemeral mode.
 * @param deps - Bus dependency
 * @returns Array of cleanup callbacks, one per registered handler
 */
export function registerCoreSessionServiceHandlers(deps: CoreSessionServiceHandlerDeps): Array<() => void> {
  return [
    registerCreateHandler(deps),
    registerGetHandler(deps),
    registerListHandler(deps),
    registerTurnAwaitHandler(deps),
    registerCloseHandler(deps),
    registerRestartAgentsHandler(deps),
    registerCoreUpdateHandler(deps),
    registerCoreArchiveHandler(deps),
    registerCorePurgeHandler(deps),
    registerRegisterExternalHandler(deps),
    registerAgentAddedHandler(deps.bus),
    registerAgentRemovedHandler(deps.bus),
  ];
}

/**
 * Handle turn completion waits.
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerTurnAwaitHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.turn.await, async (ctx) => {
    const { sessionId, turnId, timeoutMs } = ctx.payload;
    const controller = new AbortController();
    const completion = bus.once(SessionSubjects.turn.completed, {
      timeoutMs,
      filter: { sessionId, turnId },
      signal: controller.signal,
    });
    completion.catch(() => undefined);

    const storedCompletion = await getStoredTurnCompletion(bus, sessionId, turnId);
    if (storedCompletion !== undefined) {
      controller.abort();
      ctx.setResult({ completion: storedCompletion });
      return;
    }

    try {
      const completed = await completion;
      ctx.setResult({ completion: completed.payload });
    } catch (error) {
      if (error instanceof Error && error.name === 'OnceTimeoutError') {
        throw new TimeoutError('session.turn.await', timeoutMs);
      }
      throw error;
    }
  });
}

/**
 * Resolve a completed turn from durable storage, if available.
 * @param bus - Bus used for optional turn storage lookup
 * @param sessionId - Session ID expected by the await call
 * @param turnId - Turn ID expected by the await call
 * @returns Completion payload, or undefined when storage is absent/not terminal
 */
async function getStoredTurnCompletion(bus: IMakaioBus, sessionId: string, turnId: string) {
  const storedTurn = await bus.requestOptional(TurnStorageSubjects.get, { turnId });
  const turn = storedTurn.handled ? storedTurn.data.turn : null;
  if (turn?.sessionId !== sessionId || (turn.status !== 'completed' && turn.status !== 'error')) {
    return undefined;
  }
  return {
    sessionId,
    turnId,
    turnNumber: turn.turnNumber,
    success: turn.status === 'completed',
    ...(turn.error !== undefined && { error: turn.error }),
    ...(turn.initiator !== undefined && { initiator: turn.initiator }),
  };
}

/**
 * Handle session creation requests.
 *
 * Creates a new session with a unique ID and stores framework-level session
 * graph fields. Host-specific scope fields are handled by host-side subject
 * extensions or interceptors before this handler runs.
 *
 * The `ifAbsent` flag on storage set makes creation idempotent — if the
 * session already exists (caller-provided or freshly generated ID) the handler
 * returns the existing session ID without overwriting. This avoids routing new
 * sessions through the optimistic concurrency retry loop, which is designed
 * for updates to existing rows.
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerCreateHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;

  return bus.on(SessionSubjects.create, async (ctx) => {
    const {
      sessionId: providedSessionId,
      parentSessionId,
      contextInheritance,
      forkPointMessageId,
      branchKind,
      forkTransforms,
      title,
      targetWorkingDirectory,
      executionTargetId,
      spawningToolCallId,
      originWindowId,
    } = ctx.payload;
    const sessionId = providedSessionId ?? crypto.randomUUID();
    const createdAt = Date.now();
    const session: IMakaioSession = {
      sessionId,
      createdAt,
      lastActivityAt: createdAt,
      agents: [],
      status: 'active',
      title,
      parentSessionId,
      contextInheritance,
      forkPointMessageId,
      branchKind,
      forkTransforms,
      targetWorkingDirectory,
      executionTargetId,
      spawningToolCallId,
    };

    const setResult = await bus.requestOptional(SessionStorageSubjects.set, {
      sessionId,
      session,
      ifAbsent: true,
    });
    // In ephemeral mode (unhandled), treat as success — no persistent store to conflict with.
    if (setResult.handled && !setResult.data.success) {
      ctx.setResult({ sessionId });
      return;
    }

    await bus.emit(SessionSubjects.created, {
      sessionId,
      createdAt: session.createdAt,
      parentSessionId: parentSessionId ?? null,
      branchKind: branchKind ?? null,
      originWindowId: originWindowId ?? 'server',
    });

    ctx.setResult({ sessionId });
  });
}

/**
 * Handle session retrieval requests.
 *
 * Pure storage passthrough — delegates to `SessionStorageSubjects.get`.
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerGetHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.get, async (ctx) => {
    const result = await bus.requestOptional(SessionStorageSubjects.get, {
      sessionId: ctx.payload.sessionId,
    });
    const session = result.handled ? result.data.session : null;
    ctx.setResult({ session });
  });
}

/**
 * Handle session listing requests.
 *
 * Pure storage passthrough — delegates to `SessionStorageSubjects.list`.
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerListHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.list, async (ctx) => {
    const { status, limit, offset, includePreview, executionTargetId } = ctx.payload;
    const result = await bus.requestOptional(SessionStorageSubjects.list, {
      status: status ?? 'all',
      limit,
      offset,
      includePreview,
      executionTargetId,
    });
    const sessions = result.handled ? result.data.sessions : [];
    const total = result.handled ? result.data.total : 0;
    ctx.setResult({ sessions, total });
  });
}

/**
 * Handle session close requests.
 *
 * Implements the core state machine transition: `active → closed`.
 * Idempotent — already-closed sessions return `{ success: true }` without
 * re-emitting the `session.closed` event.
 *
 * Unlike the host-side close handler, this core handler does NOT clear
 * the context window tracker (a host-only UI concern).
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerCloseHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.close, async (ctx) => {
    const { sessionId } = ctx.payload;
    const getResult = await bus.requestOptional(SessionStorageSubjects.get, { sessionId });
    const session = getResult.handled ? getResult.data.session : null;
    if (!session) {
      ctx.setResult({ success: false });
      return;
    }
    if (session.status === 'closed') {
      // Idempotent close: already-closed sessions should not block higher-level workflows.
      ctx.setResult({ success: true });
      return;
    }
    if (session.status !== 'active') {
      ctx.setResult({ success: false });
      return;
    }

    session.status = 'closed';
    session.lastActivityAt = Date.now();
    await bus.requestOptional(SessionStorageSubjects.set, { sessionId, session });
    await bus.emit(SessionSubjects.closed, { sessionId });
    ctx.setResult({ success: true });
  });
}

type RestartAgentsHandlerResult =
  | { agentId: string; adapterId: string; success: true }
  | { agentId: string; adapterId: string; success: false; error: string };

/**
 * Handle explicit session agent runtime restoration.
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerRestartAgentsHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.restartAgents, async (ctx) => {
    const { sessionId } = ctx.payload;
    const listResult = await bus.requestOptional(AgentStorageSubjects.listBySession, { sessionId });
    const agents = listResult.handled ? listResult.data.agents : [];
    const results: RestartAgentsHandlerResult[] = [];

    for (const agent of agents) {
      try {
        const recovered = await recoverAgent(bus, agent, {
          cwd: agent.cwd,
          model: agent.model,
        });
        await bus.requestOptional(AgentStorageSubjects.updateRuntime, {
          agentId: recovered.agentId,
          adapterId: recovered.adapterId,
        });
        results.push({ agentId: recovered.agentId, adapterId: recovered.adapterId, success: true });
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        const message = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
        results.push({ agentId: agent.agentId, adapterId: agent.adapterId, success: false, error: message });
      }
    }

    ctx.setResult({ sessionId, results });
  });
}

/**
 * Handle generic session update requests.
 *
 * Updates framework-owned session fields from the public `session.update`
 * contract and emits `session.updated` for fields present in a successful
 * update request.
 * Host interceptors may strip or handle extended payload fields before
 * delegating to this handler.
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerCoreUpdateHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.update, async (ctx) => {
    const { sessionId, executionTargetId, approvalPolicyOverride, title } = ctx.payload;

    const updateResult = await bus.requestOptional(SessionStorageSubjects.update, {
      sessionId,
      executionTargetId,
      approvalPolicyOverride,
      title,
    });
    const success = updateResult.handled ? updateResult.data.success : false;

    if (success) {
      const changedProperties: string[] = [];
      if (executionTargetId !== undefined) changedProperties.push('executionTargetId');
      if (approvalPolicyOverride !== undefined) changedProperties.push('approvalPolicyOverride');
      if (title !== undefined) changedProperties.push('title');

      if (changedProperties.length > 0) {
        await bus.emit(SessionSubjects.updated, { sessionId, changedProperties });
      }
    }

    ctx.setResult({ success });
  });
}

/**
 * Handle session archive requests.
 *
 * Implements the core state transition `closed → archived`. Already archived
 * sessions are successful idempotent responses; other states return
 * `{ success: false }` without changing storage.
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerCoreArchiveHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.archive, async (ctx) => {
    const { sessionId } = ctx.payload;
    const getResult = await bus.requestOptional(SessionStorageSubjects.get, { sessionId });
    const session = getResult.handled ? getResult.data.session : null;
    if (!session) {
      ctx.setResult({ success: false });
      return;
    }
    if (session.status === 'archived') {
      // Idempotent archive keeps delete flows race-safe across windows/processes.
      ctx.setResult({ success: true });
      return;
    }
    if (session.status !== 'closed') {
      ctx.setResult({ success: false });
      return;
    }

    session.status = 'archived';
    session.lastActivityAt = Date.now();
    await bus.requestOptional(SessionStorageSubjects.set, { sessionId, session });
    await bus.emit(SessionSubjects.archived, { sessionId });
    ctx.setResult({ success: true });
  });
}

/**
 * Handle session purge requests.
 *
 * Permanently deletes archived sessions, removes their event history, and
 * detaches any direct child sessions from the deleted parent.
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerCorePurgeHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.purge, async (ctx) => {
    const { sessionId } = ctx.payload;
    const getResult = await bus.requestOptional(SessionStorageSubjects.get, { sessionId });
    const session = getResult.handled ? getResult.data.session : null;
    if (!session) {
      ctx.setResult({ success: false, error: 'Session not found' });
      return;
    }

    if (session.status !== 'archived') {
      ctx.setResult({ success: false, error: 'Cannot purge session unless archived. Call close then archive first.' });
      return;
    }

    const listResult = await bus.requestOptional(SessionStorageSubjects.list, { status: 'all' });
    const sessions = listResult.handled ? listResult.data.sessions : [];
    for (const child of sessions) {
      if (child.parentSessionId === sessionId) {
        await bus.requestOptional(SessionStorageSubjects.set, {
          sessionId: child.sessionId,
          session: { ...child, parentSessionId: undefined },
        });
      }
    }

    const eventsResult = await bus.requestOptional(SessionEventStorageSubjects.getEvents, {
      sessionId,
      options: { limit: 1 },
    });
    const eventsDeleted = eventsResult.handled ? eventsResult.data.totalCount : 0;
    await bus.requestOptional(SessionEventStorageSubjects.deleteBySession, { sessionId });
    await bus.requestOptional(SessionStorageSubjects.delete, { sessionId });
    await bus.emit(SessionSubjects.purged, { sessionId });
    ctx.setResult({ success: true, eventsDeleted });
  });
}

/**
 * Derive a deterministic session ID from an external adapter identity.
 *
 * The ID is a UUID-shaped digest of the (`adapterName`, `adapterSessionId`)
 * idempotency key. Deriving it deterministically is what makes concurrent
 * registrations of the same identity collide on the session primary key, so
 * the storage layer's `ifAbsent` insert rejects the loser and the conflict
 * path can return the winning session. Random IDs would make both inserts
 * succeed (the sessions table has no unique constraint covering external
 * adapter identity) and silently create duplicates.
 * @param adapterName - Adapter type name (idempotency key, first component)
 * @param adapterSessionId - External session identifier (idempotency key, second component)
 * @returns UUID-formatted (RFC 9562 version 8) digest of the identity pair
 */
function deterministicExternalSessionId(adapterName: string, adapterSessionId: string): string {
  const digest = createHash('sha256').update(`${adapterName}\u0000${adapterSessionId}`).digest('hex');
  // Format as a UUID with version nibble 8 (custom) and variant nibble 9 (RFC 4122 variant).
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-9${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Resolve an `ifAbsent` insert conflict during external session registration.
 *
 * A conflict means a session with the attempted ID already exists — either a
 * concurrent registration of the same identity won the race (deterministic
 * IDs make those collide on the primary key), or a caller-provided
 * `sessionId` collided with an unrelated session.
 * @param bus - Bus used for storage lookups
 * @param sessionId - Session ID whose insert was rejected
 * @param adapterName - Adapter identity, first component
 * @param adapterSessionId - Adapter identity, second component
 * @returns The winning session's registration response (`created: false`)
 * @throws When the conflicting session does not carry the adapter identity —
 *   claiming `created: true` would hand out a session ID with the wrong
 *   identity, so the registration fails loudly instead.
 */
async function resolveRegistrationConflict(
  bus: IMakaioBus,
  sessionId: string,
  adapterName: string,
  adapterSessionId: string,
): Promise<{ sessionId: string; created: false }> {
  const conflictLookup = await bus.requestOptional(SessionStorageSubjects.getByAdapterSessionId, {
    adapterSessionId,
    adapterName,
  });
  if (conflictLookup.handled && conflictLookup.data.session !== null) {
    const winner = conflictLookup.data.session;
    if (winner.adapterName === adapterName) {
      return { sessionId: winner.sessionId, created: false };
    }
  }
  // The adapterSessionId lookup is ambiguous when several adapters share one
  // external session ID string (it returns null for multiple matches).
  // Resolve via our own session ID: if that row carries our identity, this is
  // an idempotent re-registration.
  const byId = await bus.requestOptional(SessionStorageSubjects.get, { sessionId });
  const existing = byId.handled ? byId.data.session : null;
  if (existing !== null && existing.adapterName === adapterName && existing.adapterSessionId === adapterSessionId) {
    return { sessionId: existing.sessionId, created: false };
  }
  throw new Error(
    `session.registerExternal: session ID "${sessionId}" already exists but does not carry ` +
      `adapter identity (${adapterName}, ${adapterSessionId}); refusing to mis-attribute it`,
  );
}

/**
 * Handle external session registration requests.
 *
 * Creates a new session stamped with adapter identity fields
 * (`adapterName`, `adapterSessionId`, `lastClientIdentityObservation`).
 * This is the only public path that accepts adapter identity at session level.
 * It exists for externally-running adapter sessions where the normal
 * `session.agent.attach` pipeline cannot run (e.g. an MCP-server host or an
 * HTTP endpoint that creates sessions on behalf of external clients).
 *
 * Registration is idempotent and keyed by (`adapterName`, `adapterSessionId`).
 * If a session with that identity already exists it is returned with
 * `created: false`.
 *
 * Concurrency: when the caller omits `sessionId`, the session ID is derived
 * deterministically from the identity pair, so two concurrent registrations
 * of the same identity collide on the primary key — exactly one `ifAbsent`
 * insert succeeds and the loser resolves the winner via re-lookup. A
 * caller-provided `sessionId` that collides with an unrelated session is an
 * error (the request rejects) rather than a silently mis-attributed identity.
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerRegisterExternalHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;

  return bus.on(SessionSubjects.registerExternal, async (ctx) => {
    const {
      adapterName,
      adapterSessionId,
      lastClientIdentityObservation,
      sessionId: providedSessionId,
      parentSessionId,
      contextInheritance,
      forkPointMessageId,
      branchKind,
      forkTransforms,
      title,
      targetWorkingDirectory,
      executionTargetId,
      spawningToolCallId,
      originWindowId,
    } = ctx.payload;

    // Idempotency: look up by adapterSessionId first.
    // No `source` filter — externally-registered sessions do not carry the
    // import-provenance `source` field; `adapterName` is used instead.
    const lookupResult = await bus.requestOptional(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId,
      adapterName,
    });

    if (lookupResult.handled && lookupResult.data.session !== null) {
      const existing = lookupResult.data.session;
      // Guard: verify the returned session belongs to the same adapter.
      // A different adapter may use the same external session ID string.
      if (existing.adapterName === adapterName) {
        ctx.setResult({ sessionId: existing.sessionId, created: false });
        return;
      }
    }

    // Create a new session stamped with adapter identity. The deterministic
    // ID is the concurrency anchor — see deterministicExternalSessionId.
    const sessionId = providedSessionId ?? deterministicExternalSessionId(adapterName, adapterSessionId);
    const createdAt = Date.now();
    const session: IMakaioSession = {
      sessionId,
      createdAt,
      lastActivityAt: createdAt,
      agents: [],
      status: 'active',
      adapterName,
      adapterSessionId,
      lastClientIdentityObservation,
      title,
      parentSessionId,
      contextInheritance,
      forkPointMessageId,
      branchKind,
      forkTransforms,
      targetWorkingDirectory,
      executionTargetId,
      spawningToolCallId,
    };

    const setResult = await bus.requestOptional(SessionStorageSubjects.set, {
      sessionId,
      session,
      ifAbsent: true,
    });

    if (setResult.handled && !setResult.data.success) {
      const winner = await resolveRegistrationConflict(bus, sessionId, adapterName, adapterSessionId);
      ctx.setResult(winner);
      return;
    }

    await bus.emit(SessionSubjects.created, {
      sessionId,
      createdAt: session.createdAt,
      parentSessionId: parentSessionId ?? null,
      branchKind: branchKind ?? null,
      originWindowId: originWindowId ?? 'server',
    });

    ctx.setResult({ sessionId, created: true });
  });
}
