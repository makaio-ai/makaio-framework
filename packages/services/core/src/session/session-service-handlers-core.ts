import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type IMakaioSession } from '@makaio/contracts';
import { SessionStorageSubjects } from './storage/namespace.js';
import { registerAgentAddedHandler, registerAgentRemovedHandler } from './session-service-agent-handlers.js';

/**
 * Dependencies required to register the framework-core session service handlers.
 *
 * Intentionally minimal — no `contextTracker` or host-layer concerns.
 * Host-specific handlers (search, update, archive, purge, context window, etc.)
 * are registered separately via the host session service.
 */
interface CoreSessionServiceHandlerDeps {
  /** The event bus used for handler registration and storage dispatch. */
  bus: IMakaioBus;
}

/**
 * Registers the six framework-core session service handlers:
 * `session.create`, `session.get`, `session.list`, `session.close`,
 * `session.agent.added`, and `session.agent.removed`.
 *
 * These handlers cover the minimal, load-bearing session contract for the
 * framework SDK. Host-specific handlers (search, update, resume, archive,
 * purge, analytics, context window) are registered by the host session
 * service at a higher priority.
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
    registerCloseHandler(deps),
    registerAgentAddedHandler(deps.bus),
    registerAgentRemovedHandler(deps.bus),
  ];
}

/**
 * Handle session creation requests.
 *
 * Creates a new session with a unique ID and stores it. Accepts only
 * framework-level fields: `sessionId`, `title`, `originWindowId`.
 * Host fields (`parentSessionId`, `forkPointMessageId`, `branchKind`,
 * `forkTransforms`, `targetWorkingDirectory`, `spawningToolCallId`) are handled
 * by a host-side priority-100 interceptor that enriches the payload before
 * this handler runs.
 *
 * The `ifAbsent` flag on storage set makes creation idempotent when a
 * `sessionId` is provided — if the session already exists the handler
 * returns the existing session ID without overwriting.
 * @param deps - Core handler dependencies
 * @returns Cleanup function
 */
function registerCreateHandler(deps: CoreSessionServiceHandlerDeps): () => void {
  const { bus } = deps;

  return bus.on(SessionSubjects.create, async (ctx) => {
    const { sessionId: providedSessionId, title, originWindowId } = ctx.payload;
    const sessionId = providedSessionId ?? crypto.randomUUID();
    const createdAt = Date.now();
    const session: IMakaioSession = {
      sessionId,
      createdAt,
      lastActivityAt: createdAt,
      agents: [],
      status: 'active',
      title,
    };

    if (providedSessionId) {
      const setResult = await bus.requestOptional(SessionStorageSubjects.set, {
        sessionId,
        session,
        ifAbsent: true,
      });
      // In ephemeral mode (unhandled), treat as success — no persistent store to conflict with.
      if (setResult.handled && !setResult.data.success) {
        const getResult = await bus.requestOptional(SessionStorageSubjects.get, { sessionId });
        const existing = getResult.handled ? getResult.data.session : null;
        if (!existing) {
          throw new Error(`Session already exists but could not be loaded: ${sessionId}`);
        }
        ctx.setResult({ sessionId });
        return;
      }
    } else {
      await bus.requestOptional(SessionStorageSubjects.set, { sessionId, session });
    }

    await bus.emit(SessionSubjects.created, {
      sessionId,
      createdAt: session.createdAt,
      parentSessionId: null,
      branchKind: null,
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
