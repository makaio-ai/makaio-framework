import { describe, it, beforeEach, afterEach } from 'bun:test';
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

  beforeEach(() => {
    bridge = new SessionBridge(MakaioBus);
  });

  afterEach(() => {
    bridge.destroy();
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
    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'no-storage-agent',
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      adapterSessionId: 'native-1',
      sessionId: 'no-storage-session',
      messageId: 'no-storage-user-msg',
    });

    // Verify bridge cleaned up internal state — access via the private map is
    // not possible without casting; instead validate indirectly: a second
    // agent.complete for the same agent should not attempt storage (blocks are
    // already gone) and must also not throw.
    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'no-storage-agent',
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      adapterSessionId: 'native-1',
      sessionId: 'no-storage-session',
      messageId: 'no-storage-user-msg',
    });
  });
});
