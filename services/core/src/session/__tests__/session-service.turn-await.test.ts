import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { registerMemoryTurnStorage, TurnStorageSubjects } from '../turns/index.js';
import { MakaioSessionService } from '../session-service.js';

function getFullSubjectKey(subject: { subject: string; $meta: { namespace: string } }): string {
  return `${subject.$meta.namespace}.${subject.subject}`;
}

describe('MakaioSessionService - turn await', () => {
  let bus: IMakaioBus;
  let service: MakaioSessionService;
  let turnStorageCleanup: (() => void) | undefined;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new MakaioSessionService(bus);
    await service.init();
  });

  afterEach(() => {
    service.destroy();
    turnStorageCleanup?.();
    turnStorageCleanup = undefined;
  });

  it('resolves with the matching session.turn.completed payload', async () => {
    const completion = {
      sessionId: 'session-await-success',
      turnId: 'turn-await-success',
      turnNumber: 3,
      success: true,
      initiator: { source: 'user' as const },
    };

    const awaited = bus.request(SessionSubjects.turn.await, {
      sessionId: completion.sessionId,
      turnId: completion.turnId,
      timeoutMs: 100,
    });

    await bus.emit(SessionSubjects.turn.completed, {
      ...completion,
      turnId: 'other-turn',
    });
    await bus.emit(SessionSubjects.turn.completed, completion);

    await expect(awaited).resolves.toEqual({ completion });
  });

  it('rejects with the local RPC timeout style when completion does not arrive', async () => {
    await expect(
      bus.request(SessionSubjects.turn.await, {
        sessionId: 'session-await-timeout',
        turnId: 'turn-await-timeout',
        timeoutMs: 5,
      }),
    ).rejects.toThrow('Request to "session.turn.await" timed out after 5ms');
  });

  it('resolves from storage with the persisted turn initiator', async () => {
    turnStorageCleanup = registerMemoryTurnStorage(bus);
    const initiator = { source: 'extension' as const, sourceId: 'routine:validation' };
    const { turn } = await bus.request(TurnStorageSubjects.create, {
      sessionId: 'session-await-completed',
      initiator,
    });
    const { turn: completed } = await bus.request(TurnStorageSubjects.complete, {
      turnId: turn.turnId,
      status: 'completed',
    });

    await expect(
      bus.request(SessionSubjects.turn.await, {
        sessionId: completed.sessionId,
        turnId: completed.turnId,
        timeoutMs: 5,
      }),
    ).resolves.toEqual({
      completion: {
        sessionId: completed.sessionId,
        turnId: completed.turnId,
        turnNumber: completed.turnNumber,
        success: true,
        initiator,
      },
    });
    expect(bus.getContext().eventHandlers.has(getFullSubjectKey(SessionSubjects.turn.completed))).toBe(false);
  });

  it('resolves from storage with persisted turn usage', async () => {
    turnStorageCleanup = registerMemoryTurnStorage(bus);
    const usage = {
      total: { inputTokens: 120, outputTokens: 45 },
      byAgent: { 'agent-a': { inputTokens: 120, outputTokens: 45 } },
    };
    const { turn } = await bus.request(TurnStorageSubjects.create, {
      sessionId: 'session-await-completed-usage',
    });
    const { turn: completed } = await bus.request(TurnStorageSubjects.complete, {
      turnId: turn.turnId,
      status: 'completed',
      usage,
    });

    await expect(
      bus.request(SessionSubjects.turn.await, {
        sessionId: completed.sessionId,
        turnId: completed.turnId,
        timeoutMs: 5,
      }),
    ).resolves.toEqual({
      completion: {
        sessionId: completed.sessionId,
        turnId: completed.turnId,
        turnNumber: completed.turnNumber,
        success: true,
        usage,
      },
    });
  });

  it('does not invent an initiator for historical completed turns without one', async () => {
    turnStorageCleanup = registerMemoryTurnStorage(bus);
    const { turn } = await bus.request(TurnStorageSubjects.create, { sessionId: 'session-await-unknown-origin' });
    const { turn: completed } = await bus.request(TurnStorageSubjects.complete, {
      turnId: turn.turnId,
      status: 'completed',
    });

    await expect(
      bus.request(SessionSubjects.turn.await, {
        sessionId: completed.sessionId,
        turnId: completed.turnId,
        timeoutMs: 5,
      }),
    ).resolves.toEqual({
      completion: {
        sessionId: completed.sessionId,
        turnId: completed.turnId,
        turnNumber: completed.turnNumber,
        success: true,
      },
    });
  });
});
