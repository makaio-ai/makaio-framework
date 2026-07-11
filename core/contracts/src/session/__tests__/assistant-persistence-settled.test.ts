import { describe, expect, it } from 'vitest';
import { OrchestratorSchemas } from '../schemas/orchestrator.js';

describe("OrchestratorSchemas['turn.assistantPersistenceSettled']", () => {
  const subject = OrchestratorSchemas['turn.assistantPersistenceSettled'];

  it('is local-only coordination metadata', () => {
    expect(subject.__local).toBe(true);
  });

  it('requires session, turn, agent, and message identity', () => {
    expect(
      subject.schema.safeParse({
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentId: 'agent-1',
        messageId: 'message-1',
      }).success,
    ).toBe(true);
    expect(subject.schema.safeParse({ sessionId: 'session-1', turnId: 'turn-1', agentId: 'agent-1' }).success).toBe(
      false,
    );
    expect(subject.schema.safeParse({ sessionId: 'session-1', turnId: 'turn-1', messageId: 'message-1' }).success).toBe(
      false,
    );
  });
});
