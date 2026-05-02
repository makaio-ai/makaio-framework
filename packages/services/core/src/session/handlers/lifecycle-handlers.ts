import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { SessionEventStorageSubjects } from '../session-events/namespace.js';
import { ContextWindowTracker } from '../context-window/index.js';

/**
 * Dependencies for session lifecycle handlers.
 */
interface SessionLifecycleDeps {
  bus: IMakaioBus;
  contextTracker: ContextWindowTracker;
}

/**
 * Register handler for session.getStatusCounts.
 * @param deps - Handler dependencies
 * @returns Cleanup function
 */
export function registerGetStatusCountsHandler(deps: SessionLifecycleDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.getStatusCounts, async (ctx) => {
    void ctx.payload;
    const { all, active, closed, archived, discovered } = await bus.request(SessionStorageSubjects.getStatusCounts, {});
    ctx.setResult({ all, active, closed, archived, discovered });
  });
}

/**
 * Register handler for session.close.
 * @param deps - Handler dependencies
 * @returns Cleanup function
 */
export function registerCloseHandler(deps: SessionLifecycleDeps): () => void {
  const { bus, contextTracker } = deps;
  return bus.on(SessionSubjects.close, async (ctx) => {
    const { sessionId } = ctx.payload;
    const { session } = await bus.request(SessionStorageSubjects.get, { sessionId });
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
    await bus.request(SessionStorageSubjects.set, { sessionId, session });
    await bus.emit(SessionSubjects.closed, { sessionId });
    contextTracker.clearSession(sessionId);
    ctx.setResult({ success: true });
  });
}

/**
 * Register handler for session.resume.
 * @param deps - Handler dependencies
 * @returns Cleanup function
 */
export function registerResumeHandler(deps: SessionLifecycleDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.resume, async (ctx) => {
    const { sessionId } = ctx.payload;
    const { session } = await bus.request(SessionStorageSubjects.get, { sessionId });
    if (!session || session.status !== 'closed') {
      ctx.setResult({ success: false });
      return;
    }

    session.status = 'active';
    session.lastActivityAt = Date.now();
    await bus.request(SessionStorageSubjects.set, { sessionId, session });
    await bus.emit(SessionSubjects.resumed, { sessionId });
    ctx.setResult({ success: true });
  });
}

/**
 * Register handler for session.archive.
 * @param deps - Handler dependencies
 * @returns Cleanup function
 */
export function registerArchiveHandler(deps: SessionLifecycleDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.archive, async (ctx) => {
    const { sessionId } = ctx.payload;
    const { session } = await bus.request(SessionStorageSubjects.get, { sessionId });
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
    await bus.request(SessionStorageSubjects.set, { sessionId, session });
    await bus.emit(SessionSubjects.archived, { sessionId });
    ctx.setResult({ success: true });
  });
}

/**
 * Register handler for session.purge.
 * @param deps - Handler dependencies
 * @returns Cleanup function
 */
export function registerPurgeHandler(deps: SessionLifecycleDeps): () => void {
  const { bus } = deps;
  return bus.on(SessionSubjects.purge, async (ctx) => {
    const { sessionId } = ctx.payload;
    const { session } = await bus.request(SessionStorageSubjects.get, { sessionId });
    if (!session) {
      ctx.setResult({ success: false, error: 'Session not found' });
      return;
    }

    if (session.status !== 'archived') {
      ctx.setResult({ success: false, error: 'Cannot purge session unless archived. Call close then archive first.' });
      return;
    }

    const { sessions } = await bus.request(SessionStorageSubjects.list, { status: 'all' });
    for (const child of sessions) {
      if (child.parentSessionId === sessionId) {
        await bus.request(SessionStorageSubjects.set, {
          sessionId: child.sessionId,
          session: { ...child, parentSessionId: undefined },
        });
      }
    }

    const { totalCount } = await bus.request(SessionEventStorageSubjects.getEvents, {
      sessionId,
      options: { limit: 1 },
    });
    await bus.request(SessionEventStorageSubjects.deleteBySession, { sessionId });
    await bus.request(SessionStorageSubjects.delete, { sessionId });
    await bus.emit(SessionSubjects.purged, { sessionId });
    ctx.setResult({ success: true, eventsDeleted: totalCount });
  });
}
