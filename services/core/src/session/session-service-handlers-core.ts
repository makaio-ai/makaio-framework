import { TimeoutError, type IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type IMakaioSession, type OwnershipTopology } from '@makaio/contracts';
import { TurnStorageSubjects } from '../turn/namespace.js';
import { SessionEventStorageSubjects } from './session-events/namespace.js';
import { SessionStorageSubjects } from './storage/namespace.js';
import {
  registerAdapterSessionIdReconciliationHandler,
  registerAgentAddedHandler,
  registerAgentRemovedHandler,
} from './session-service-agent-handlers.js';
import { registerAdapterSessionMovementObserver, registerSessionOwnershipAuthority } from './ownership/index.js';
import { registerRestartAgentsHandler } from './handlers/restart-agents.js';

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
  /**
   * Machine identity the ownership authority owns claims under.
   *
   * Injected by the composition root, never resolved through the bus: an
   * ownership decision must not depend on whether the adapter runtime's
   * identity handler happened to register first. Absent, every
   * identity-dependent ownership operation declines instead of guessing.
   */
  machineId?: string;
  /**
   * How many runtime processes may own claims on this machine. Defaults to
   * `'shared-machine'` — the reading no host can be wrong about.
   */
  topology?: OwnershipTopology;
}

/**
 * Registers the framework-core session service handlers:
 * `session.create`, `session.get`, `session.list`, `session.turn.await`,
 * `session.close`, `session.restartAgents`, `session.update`,
 * `session.archive`, `session.purge`,
 * `session.agent.added`, `session.agent.removed`, and the five
 * `session.ownership.*` operations of the ownership authority.
 *
 * These handlers cover the minimal, load-bearing session contract for the
 * framework SDK. Host-specific handlers (search, resume, analytics, context
 * window) are registered by the host session service at a higher priority.
 *
 * Persistence degrades gracefully when no storage handlers are registered:
 * `session.get` / `session.list` / `session.close` all delegate to
 * `SessionStorageSubjects.*` which may be unhandled in ephemeral mode.
 * @param deps - Bus, plus the identity the ownership authority is composed with
 * @returns Array of cleanup callbacks, one per registered handler
 */
export function registerCoreSessionServiceHandlers(deps: CoreSessionServiceHandlerDeps): Array<() => void> {
  return [
    registerCreateHandler(deps),
    registerGetHandler(deps),
    registerListHandler(deps),
    registerTurnAwaitHandler(deps),
    registerCloseHandler(deps),
    registerRestartAgentsHandler(deps.bus),
    registerCoreUpdateHandler(deps),
    registerCoreArchiveHandler(deps),
    registerCorePurgeHandler(deps),
    registerAgentAddedHandler(deps.bus),
    registerAgentRemovedHandler(deps.bus),
    registerAdapterSessionIdReconciliationHandler(deps.bus),
    registerSessionOwnershipAuthority({
      bus: deps.bus,
      machineId: deps.machineId,
      topology: deps.topology ?? 'shared-machine',
    }),
    registerAdapterSessionMovementObserver(deps.bus),
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
    ...(turn.usage !== undefined && { usage: turn.usage }),
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
      metadata,
      spawningToolCallId,
      originWindowId,
      machineId,
    } = ctx.payload;
    const sessionId = providedSessionId ?? crypto.randomUUID();

    const parentSession =
      parentSessionId === undefined
        ? undefined
        : (await bus.request(SessionSubjects.get, { sessionId: parentSessionId })).session;

    if (parentSessionId !== undefined && parentSession === null) {
      throw new Error(`[session.create] Parent session not found: ${parentSessionId}`);
    }

    // parentSession is `undefined` (no parent) or `IMakaioSession` (parent found — null case is rejected above)
    const rootSessionId = parentSession ? (parentSession.rootSessionId ?? parentSession.sessionId) : undefined;

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
      metadata,
      spawningToolCallId,
      ...(rootSessionId !== undefined && { rootSessionId }),
      ...(machineId !== undefined && { machineId }),
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
    const { sessionId, executionTargetId, approvalPolicyOverride, title, metadata } = ctx.payload;

    const updateResult = await bus.requestOptional(SessionStorageSubjects.update, {
      sessionId,
      executionTargetId,
      approvalPolicyOverride,
      title,
      metadata,
    });
    const success = updateResult.handled ? updateResult.data.success : false;

    if (success) {
      const changedProperties: string[] = [];
      if (executionTargetId !== undefined) changedProperties.push('executionTargetId');
      if (approvalPolicyOverride !== undefined) changedProperties.push('approvalPolicyOverride');
      if (title !== undefined) changedProperties.push('title');
      if (metadata !== undefined) changedProperties.push('metadata');

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
