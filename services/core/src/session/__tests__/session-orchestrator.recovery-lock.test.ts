import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession } from '@makaio/contracts';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import {
  createMockAgent,
  createMockSession,
  registerCreateSessionHandler,
  registerGetAgentHandler,
  registerGetSessionHandler,
  registerRehydrateAgentHandler,
  registerCwdChangeHandler,
  resetBusHandlers,
  type UnsubscribeFunction,
} from '../testing/orchestrator-shared.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** Create a deterministic test gate. */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('SessionOrchestrator - Recovery Overlap', () => {
  let orchestrator: SessionOrchestrator;
  let unsubscribers: UnsubscribeFunction[];
  let sessions: Map<string, IMakaioSession>;

  beforeEach(() => {
    resetBusHandlers();
    unsubscribers = [];
    sessions = new Map();
    unsubscribers.push(registerGetSessionHandler(sessions));
    unsubscribers.push(registerCreateSessionHandler(sessions));
    unsubscribers.push(registerGetAgentHandler(sessions));
    unsubscribers.push(registerRehydrateAgentHandler());
    unsubscribers.push(registerCwdChangeHandler());
    unsubscribers.push(registerMockStorageHandlers());
  });

  afterEach(() => {
    orchestrator?.destroy();
    unsubscribers.forEach((unsub) => unsub());
  });

  it('does not single-flight recovery for concurrent messages on one turn', async () => {
    const sessionId = 'session-recovery-overlap';
    sessions.set(
      sessionId,
      createMockSession({
        sessionId,
        agents: [createMockAgent('agent-1', { role: 'lead' }), createMockAgent('agent-2')],
        leadAgentId: 'agent-1',
      }),
    );

    unsubscribers[2]?.();
    unsubscribers[2] = MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      if (ctx.payload.agentId === 'agent-1') {
        ctx.setResult({ agent: null });
        return;
      }
      ctx.setResult({
        agent: {
          agentId: ctx.payload.agentId,
          sessionId,
          adapterSessionId: `adapter-session-${ctx.payload.agentId}`,
        },
      });
    });

    const firstRehydrateStarted = createDeferred<void>();
    const releaseFirstRehydrate = createDeferred<void>();
    const secondRehydrateStarted = createDeferred<void>();
    const releaseSecondRehydrate = createDeferred<void>();
    let rehydrateCallCount = 0;
    unsubscribers[3]?.();
    unsubscribers[3] = MakaioBus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
      rehydrateCallCount += 1;
      if (rehydrateCallCount === 1) {
        firstRehydrateStarted.resolve();
        await releaseFirstRehydrate.promise;
      } else if (rehydrateCallCount === 2) {
        secondRehydrateStarted.resolve();
        await releaseSecondRehydrate.promise;
      }
      ctx.setResult({});
    });

    const sent: Array<{ agentId: string; message: string }> = [];
    const firstRouteStarted = createDeferred<void>();
    unsubscribers.push(
      MakaioBus.on(AgentSubjects.sendMessage, (ctx) => {
        const message =
          typeof ctx.payload.message === 'string' ? ctx.payload.message : JSON.stringify(ctx.payload.message);
        sent.push({ agentId: ctx.payload.agentId, message });
        if (message === 'overlap-superset') firstRouteStarted.resolve();
        ctx.setResult({ messageId: ctx.payload.messageId ?? crypto.randomUUID() });
      }),
    );
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    const first = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'overlap-superset',
      agentIds: ['agent-1', 'agent-2'],
    });
    await firstRehydrateStarted.promise;
    const second = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'overlap-subset',
      agentIds: ['agent-1'],
    });

    await secondRehydrateStarted.promise;
    releaseFirstRehydrate.resolve();
    await firstRouteStarted.promise;
    releaseSecondRehydrate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(rehydrateCallCount).toBe(2);
    expect(firstResult.turnId).toBe(secondResult.turnId);
    expect(sent).toEqual(
      expect.arrayContaining([
        { agentId: 'agent-1', message: 'overlap-superset' },
        { agentId: 'agent-2', message: 'overlap-superset' },
        { agentId: 'agent-1', message: 'overlap-subset' },
      ]),
    );
    expect(sent).toHaveLength(3);
  });
});
