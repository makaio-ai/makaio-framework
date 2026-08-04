import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession } from '@makaio/contracts';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { runExclusiveStart } from '../ownership/in-flight-starts.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import { settleEventLoop } from './shared.js';
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

  it('routes concurrent messages for one dead agent on a single turn', async () => {
    const sessionId = 'session-recovery-overlap';
    sessions.set(
      sessionId,
      createMockSession({
        sessionId,
        agents: [createMockAgent('agent-1', { role: 'lead' }), createMockAgent('agent-2')],
        leadAgentId: 'agent-1',
      }),
    );
    registerDeadAgentProbe(sessionId);

    const firstRehydrateStarted = createDeferred<void>();
    const releaseFirstRehydrate = createDeferred<void>();
    let rehydrateCallCount = 0;
    unsubscribers[3]?.();
    unsubscribers[3] = MakaioBus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
      rehydrateCallCount += 1;
      if (rehydrateCallCount === 1) {
        firstRehydrateStarted.resolve();
        await releaseFirstRehydrate.promise;
      }
      ctx.setResult({});
    });

    const sent = registerSendCapture();
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
    // Drained before the first rehydrate is released, so the second send has
    // provably reached the agent it shares with the first while that agent's
    // attempt is still open. Releasing straight away would let the entry clear
    // first and turn the assertion below into a coin toss.
    await settleEventLoop();
    releaseFirstRehydrate.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    // One lifecycle for one agent identity: the second send joined the first
    // send's rehydrate rather than dispatching a second one at the same
    // connector.
    expect(rehydrateCallCount).toBe(1);
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

  it('joins an in-flight start for a dead agent instead of dispatching a second rehydrate', async () => {
    const sessionId = 'session-recovery-join';
    sessions.set(
      sessionId,
      createMockSession({
        sessionId,
        agents: [createMockAgent('agent-1', { role: 'lead' })],
        leadAgentId: 'agent-1',
      }),
    );
    registerDeadAgentProbe(sessionId);

    let rehydrateCallCount = 0;
    unsubscribers[3]?.();
    unsubscribers[3] = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({});
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    // Something else in this process is already rebuilding agent-1 — a restart,
    // or another send that got there first. The lifecycle is exclusive per agent
    // identity, so the send must wait for that attempt rather than open a second
    // one beside it.
    const attempt = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', () => attempt.promise);

    const send = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'joins-the-attempt',
      agentIds: ['agent-1'],
    });
    try {
      await settleEventLoop();
      expect(rehydrateCallCount).toBe(0);
      expect(sent).toHaveLength(0);
    } finally {
      // Opened whatever the assertions above did: the registry is process-wide,
      // so a failed expectation must not leave this agent's entry pending for
      // every test that follows.
      attempt.resolve();
    }
    await inFlight.settled;
    await send;
    // Still nothing: the send consumed the attempt it joined instead of
    // dispatching its own rehydrate once the entry cleared.
    expect(rehydrateCallCount).toBe(0);
    expect(sent).toEqual([{ agentId: 'agent-1', message: 'joins-the-attempt' }]);
  });

  /**
   * Report `agent-1` as gone and every other agent as live.
   * @param sessionId - Session the probed agents belong to.
   */
  function registerDeadAgentProbe(sessionId: string): void {
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
  }

  /**
   * Capture every message routed to an agent.
   * @returns The growing capture list.
   */
  function registerSendCapture(): Array<{ agentId: string; message: string }> {
    const sent: Array<{ agentId: string; message: string }> = [];
    unsubscribers.push(
      MakaioBus.on(AgentSubjects.sendMessage, (ctx) => {
        const message =
          typeof ctx.payload.message === 'string' ? ctx.payload.message : JSON.stringify(ctx.payload.message);
        sent.push({ agentId: ctx.payload.agentId, message });
        ctx.setResult({ messageId: ctx.payload.messageId ?? crypto.randomUUID() });
      }),
    );
    return sent;
  }
  it('fails the send when the recovery it joined failed', async () => {
    // A rehydrate writes no status when it fails, so the agent row looks exactly
    // as it did before while the connector was never built. Swallowing the
    // joined rejection would admit a turn and persist a user message against an
    // agent that cannot answer.
    const sessionId = 'session-recovery-joined-failure';
    sessions.set(
      sessionId,
      createMockSession({
        sessionId,
        agents: [createMockAgent('agent-1', { role: 'lead' })],
        leadAgentId: 'agent-1',
      }),
    );
    registerDeadAgentProbe(sessionId);

    let rehydrateCallCount = 0;
    unsubscribers[3]?.();
    unsubscribers[3] = MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateCallCount += 1;
      ctx.setResult({});
    });
    const sent = registerSendCapture();
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    // The attempt another send is already running for this agent, which fails.
    const attempt = createDeferred<void>();
    const inFlight = runExclusiveStart('agent-1', async () => {
      await attempt.promise;
      throw new Error('connector refused to come back');
    });

    const send = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'joins-a-failing-attempt',
      agentIds: ['agent-1'],
    });
    try {
      await settleEventLoop();
    } finally {
      attempt.resolve();
    }
    await inFlight.settled.catch(() => undefined);

    await expect(send).rejects.toThrow('was joined from another send');
    // Nothing was dispatched by this send, and nothing was routed to an agent
    // whose connector does not exist.
    expect(rehydrateCallCount).toBe(0);
    expect(sent).toEqual([]);
  });
});
