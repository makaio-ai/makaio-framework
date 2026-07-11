import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { HookAbortError } from '@makaio/hooks';
import { SessionTurnManager } from '../../session-turn-manager.js';
import { createTestAgent, createTestSession } from '../../__tests__/shared.js';
import { routeToAgentsCore } from '../route-to-agents-core.js';
import { createRouteTestContext, ROUTE_TEST_IDS, type RouteTestContext } from './shared.js';

describe('routeToAgentsCore persistence settlement', () => {
  const { sessionId, messageId, turnId, testMessage } = ROUTE_TEST_IDS;
  let ctx: RouteTestContext;

  beforeEach(() => {
    ctx = createRouteTestContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  it('settles every directly terminalized agent before completing a mixed-failure turn', async () => {
    const settlements: Array<{ sessionId: string; turnId: string; messageId: string; agentId: string }> = [];
    ctx.trackUnsubscribe(
      MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        if (context.payload.agentId === 'agent-1') {
          throw new Error('Agent unreachable');
        }
        throw new HookAbortError('policy-check', 'cancel requested');
      }),
    );
    ctx.trackUnsubscribe(
      MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, ({ payload }) => {
        settlements.push(payload);
      }),
    );

    const agents = [createTestAgent('agent-1'), createTestAgent('agent-2')];
    const session = createTestSession(sessionId, { agents });
    const turnManager = new SessionTurnManager(MakaioBus);
    const admission = await turnManager.acquireMessageAdmission(
      sessionId,
      agents.map((agent) => agent.agentId),
      messageId,
      undefined,
      turnId,
    );
    admission.commit();
    const turn = admission.turn;
    const onTurnComplete = vi.fn(async () => {
      expect(settlements).toHaveLength(2);
    });

    const outcomes = await routeToAgentsCore(
      MakaioBus,
      session,
      agents,
      testMessage,
      messageId,
      turn,
      undefined,
      onTurnComplete,
      turnManager,
      undefined,
      undefined,
    );

    expect(settlements).toEqual(
      expect.arrayContaining([
        { sessionId, turnId, messageId, agentId: 'agent-1' },
        { sessionId, turnId, messageId, agentId: 'agent-2' },
      ]),
    );
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'agent-1', kind: 'failed' }),
        expect.objectContaining({ agentId: 'agent-2', kind: 'cancelled' }),
      ]),
    );
  });

  it.each([
    'user-message completion',
    'assistant-persistence settlement',
  ] as const)('terminalizes an errored agent when the %s observer rejects', async (failedObserver) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let observerCalls = 0;
    if (failedObserver === 'user-message completion') {
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.user_message.completed, () => {
          observerCalls += 1;
          throw new Error('user-message observer failed');
        }),
      );
    } else {
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, () => {
          observerCalls += 1;
          throw new Error('persistence observer failed');
        }),
      );
    }
    ctx.trackUnsubscribe(
      MakaioBus.on(AgentSubjects.sendMessage, () => {
        throw new Error('routing failed');
      }),
    );

    const agent = createTestAgent('agent-1');
    const session = createTestSession(sessionId, { agents: [agent] });
    const turnManager = new SessionTurnManager(MakaioBus);
    const admission = await turnManager.acquireMessageAdmission(
      sessionId,
      [agent.agentId],
      messageId,
      undefined,
      turnId,
    );
    admission.commit();
    const turn = admission.turn;
    const onTurnComplete = vi.fn().mockResolvedValue(undefined);

    await routeToAgentsCore(
      MakaioBus,
      session,
      [agent],
      testMessage,
      messageId,
      turn,
      undefined,
      onTurnComplete,
      turnManager,
      undefined,
      undefined,
    );

    expect(observerCalls).toBe(1);
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenCalledWith(turn, {
      success: false,
      errors: [expect.stringContaining('routing failed')],
    });
  });
});
