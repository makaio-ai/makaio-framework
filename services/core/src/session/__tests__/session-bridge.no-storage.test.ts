import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { SessionBridge } from '../session-bridge.js';

/**
 * Verify that SessionBridge gracefully degrades when no storage handlers are
 * registered. This exercises the `requestOptional` paths added to
 * `storeAssistantMessage`.
 */
describe('SessionBridge graceful degradation (no storage handlers)', () => {
  let bridge: SessionBridge;
  let stopSettlementCollection: (() => void) | undefined;
  let settlements: Array<{ sessionId: string; turnId: string; messageId: string; agentId: string }>;

  beforeEach(() => {
    settlements = [];
    stopSettlementCollection = MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, (ctx) => {
      settlements.push(ctx.payload);
    });
    bridge = new SessionBridge(MakaioBus);
  });

  afterEach(() => {
    bridge.destroy();
    stopSettlementCollection?.();
  });

  it('completes without error and cleans up agent blocks when no handlers are registered', async () => {
    // Build agent→session mapping
    await MakaioBus.emit(SessionSubjects.agent.added, {
      agentId: 'no-storage-agent',
      sessionId: 'no-storage-session',
      adapterSessionId: 'native-1',
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
    });

    // Set up turn context
    await MakaioBus.emit(SessionSubjects.turn.started, {
      sessionId: 'no-storage-session',
      turnId: 'no-storage-turn',
      turnNumber: 1,
      messageId: 'no-storage-user-msg',
      agentIds: ['no-storage-agent'],
    });

    // Accumulate a text block
    await MakaioBus.emit(AgentSubjects.message, {
      agentId: 'no-storage-agent',
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      adapterSessionId: 'native-1',
      sessionId: 'no-storage-session',
      messageId: 'no-storage-user-msg',
      content: 'hello from agent',
    });

    // Trigger storage — no handlers registered, should not throw
    await expect(
      MakaioBus.emit(AgentSubjects.complete, {
        agentId: 'no-storage-agent',
        adapterId: 'adapter-1',
        adapterName: 'openai-node',
        adapterSessionId: 'native-1',
        sessionId: 'no-storage-session',
        turnId: 'no-storage-turn',
        messageId: 'no-storage-user-msg',
      }),
    ).resolves.not.toThrow();

    expect(settlements).toEqual([
      {
        sessionId: 'no-storage-session',
        turnId: 'no-storage-turn',
        messageId: 'no-storage-user-msg',
        agentId: 'no-storage-agent',
      },
    ]);

    // A duplicate terminal event must not claim or emit persistence settlement
    // a second time for the same agent and turn.
    await expect(
      MakaioBus.emit(AgentSubjects.complete, {
        agentId: 'no-storage-agent',
        adapterId: 'adapter-1',
        adapterName: 'openai-node',
        adapterSessionId: 'native-1',
        sessionId: 'no-storage-session',
        turnId: 'no-storage-turn',
        messageId: 'no-storage-user-msg',
      }),
    ).resolves.not.toThrow();
    expect(settlements).toHaveLength(1);
  });

  it('drops the exact pending response after direct routing settlement', async () => {
    await MakaioBus.emit(SessionSubjects.turn.started, {
      sessionId: 'session-direct',
      turnId: 'turn-direct',
      turnNumber: 1,
      messageId: 'message-direct',
      agentIds: ['agent-direct'],
    });
    await MakaioBus.emit(SessionSubjects.turn.assistantPersistenceSettled, {
      sessionId: 'session-direct',
      turnId: 'turn-direct',
      messageId: 'message-direct',
      agentId: 'agent-direct',
    });
    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'agent-direct',
      adapterId: 'adapter-direct',
      adapterName: 'openai-node',
      sessionId: 'session-direct',
      turnId: 'turn-direct',
      messageId: 'message-direct',
    });

    expect(settlements).toEqual([
      { sessionId: 'session-direct', turnId: 'turn-direct', messageId: 'message-direct', agentId: 'agent-direct' },
    ]);
  });
});
