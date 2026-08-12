import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
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

    const resumed = await bus.requestOptional(SessionStorageSubjects.update, {
      sessionId,
      status: 'active',
      lastActivityAt: Date.now(),
      expectedStatus: ['closed'],
    });
    if (resumed.handled && resumed.data.success) {
      await bus.emit(SessionSubjects.resumed, { sessionId });
      ctx.setResult({ success: true });
      return;
    }
    // A competing resume is idempotently successful, but this losing CAS must
    // not revive an archive or emit a second event.
    const current = await bus.requestOptional(SessionStorageSubjects.get, { sessionId });
    ctx.setResult({ success: current.handled && current.data.session?.status === 'active' });
  });
}
