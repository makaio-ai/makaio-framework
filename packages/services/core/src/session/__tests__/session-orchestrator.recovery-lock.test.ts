import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession } from '@makaio/contracts';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import {
  createMockAgent,
  createMockSession,
  registerCreateSessionHandler,
  registerGetAgentHandler,
  registerGetSessionHandler,
  registerSendMessageHandler,
  registerRehydrateAgentHandler,
  registerCwdChangeHandler,
  resetBusHandlers,
  type UnsubscribeFunction,
  waitForAsync,
} from '../testing/orchestrator-shared.js';

describe('SessionOrchestrator - Recovery Lock', () => {
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

  it('handles overlapping target recovery for the same dead agent', async () => {
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
    unsubscribers[2] = MakaioBus.on(AdapterSubjects.getAgent, async (ctx) => {
      if (ctx.payload.agentId === 'agent-1') {
        await waitForAsync(25);
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

    let rehydrateCallCount = 0;
    unsubscribers[3]?.();
    unsubscribers[3] = MakaioBus.on(AdapterSubjects.rehydrateAgent, async (ctx) => {
      rehydrateCallCount += 1;
      await waitForAsync(10);
      ctx.setResult({});
    });

    const sent: Array<{ agentId: string; message: string }> = [];
    unsubscribers.push(
      registerSendMessageHandler((payload) => {
        const message = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload.message);
        sent.push({ agentId: payload.agentId, message });
      }),
    );
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    const first = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'overlap-1',
      agentIds: ['agent-1'],
    });
    await waitForAsync(5);
    const second = MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId,
      message: 'overlap-2',
      agentIds: ['agent-1', 'agent-2'],
    });

    await Promise.all([first, second]);

    // Session orchestrator has no lock/single-flight: each request attempts recovery.
    // Adapter-level single-flight is validated separately in adapter tests.
    expect(rehydrateCallCount).toBe(2);
    expect(sent).toContainEqual({ agentId: 'agent-2', message: 'overlap-2' });
  });
});
