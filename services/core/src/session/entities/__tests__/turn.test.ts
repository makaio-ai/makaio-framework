import { describe, it, expect } from 'vitest';
import { Turn } from '../turn.js';

describe('Turn (moved to entities)', () => {
  it('creates turn with generated ID', () => {
    const turn = new Turn({ sessionId: 'sess-1', agentIds: ['agent-1'], turnNumber: 1 });

    expect(turn.turnId).toBeDefined();
    expect(turn.sessionId).toBe('sess-1');
    expect(turn.agentIds).toEqual(['agent-1']);
    expect(turn.isComplete()).toBe(false);
  });

  it('tracks admitted message-agent completion and returns state change', () => {
    const turn = new Turn({ sessionId: 'sess-1', agentIds: ['agent-1', 'agent-2'], turnNumber: 1 });
    turn.addMessage('msg-1');

    const change1 = turn.recordPairTerminal('msg-1', 'agent-1', 'completed');
    expect(change1.turnComplete).toBe(false);

    const change2 = turn.recordPairTerminal('msg-1', 'agent-2', 'completed');
    expect(change2.turnComplete).toBe(true);
    if (change2.turnComplete) {
      expect(change2.result.success).toBe(true);
    }
  });

  it('does not count duplicate mixed terminal outcomes for one delivery pair twice', () => {
    const turn = new Turn({ sessionId: 'sess-1', agentIds: ['agent-1', 'agent-2'], turnNumber: 1 });
    turn.addMessage('msg-1');

    const completed = turn.recordPairTerminal('msg-1', 'agent-1', 'completed');
    expect(completed.turnComplete).toBe(false);

    const duplicateError = turn.recordPairTerminal('msg-1', 'agent-1', 'error', 'late failure');
    expect(duplicateError.accepted).toBe(false);
    expect(duplicateError.turnComplete).toBe(false);
    expect(turn.isComplete()).toBe(false);

    const final = turn.recordPairTerminal('msg-1', 'agent-2', 'completed');
    expect(final.turnComplete).toBe(true);
    if (final.turnComplete) {
      expect(final.result).toEqual({ success: true, errors: [] });
    }
  });

  it('adds messages to turn', () => {
    const turn = new Turn({ sessionId: 'sess-1', agentIds: ['agent-1'], turnNumber: 1 });

    turn.addMessage('msg-1');
    turn.addMessage('msg-2');

    expect(turn.messageIds).toEqual(['msg-1', 'msg-2']);
  });

  it('defensively copies initiator metadata', () => {
    const initiator = { source: 'extension' as const, sourceId: 'routine:validation' };
    const turn = new Turn({ sessionId: 'sess-1', agentIds: ['agent-1'], turnNumber: 1, initiator });

    initiator.sourceId = 'mutated';
    expect(turn.initiator).toEqual({ source: 'extension', sourceId: 'routine:validation' });

    const returned = turn.initiator;
    returned.sourceId = 'mutated-again';
    expect(turn.initiator).toEqual({ source: 'extension', sourceId: 'routine:validation' });
  });
});
