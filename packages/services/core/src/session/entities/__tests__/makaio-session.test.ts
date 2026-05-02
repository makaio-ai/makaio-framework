import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { ExtractSubjectPayload, SubjectDefinition } from '@makaio/core';
import { MakaioSession, type MakaioSessionConfig } from '../makaio-session.js';
import { Turn } from '../turn.js';

// Register a test namespace for emit helper tests
const { subjects: TestSubjects } = MakaioBus.registerNamespace('makaioSessionTest', {
  testEvent: z.object({
    sessionId: z.string(),
    foo: z.string(),
  }),
});

describe('MakaioSession', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('construction', () => {
    it('creates session with required config', () => {
      const config: MakaioSessionConfig = {
        sessionId: 'sess-123',
        bus: MakaioBus,
      };

      const session = new MakaioSession(config);

      expect(session.sessionId).toBe('sess-123');
      expect(session.status).toBe('active');
      expect(session.turns).toEqual([]);
    });

    it('generates sessionId if not provided', () => {
      const session = new MakaioSession({ bus: MakaioBus });

      expect(session.sessionId).toBeDefined();
      expect(session.sessionId).toMatch(/^[a-f0-9-]{36}$/); // UUID format
    });
  });

  describe('emit helper', () => {
    it('emits event with sessionId auto-enriched', async () => {
      const received: unknown[] = [];

      // Subscribe to the test subject
      const cleanup = MakaioBus.on(TestSubjects.testEvent, (ctx) => {
        received.push(ctx.payload);
      });

      // Use the protected emit via a test subclass
      class TestableSession extends MakaioSession {
        public async testEmit<S extends SubjectDefinition>(
          subject: S,
          payload: Omit<ExtractSubjectPayload<S>, 'sessionId'>,
        ) {
          await this.emit(subject, payload);
        }
      }

      const testSession = new TestableSession({ sessionId: 'sess-123', bus: MakaioBus });
      await testSession.testEmit(TestSubjects.testEvent, { foo: 'bar' });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        foo: 'bar',
        sessionId: 'sess-123',
      });

      cleanup();
    });
  });

  describe('startTurn', () => {
    it('creates Turn and adds to turns array', async () => {
      const session = new MakaioSession({ sessionId: 'sess-123', bus: MakaioBus });

      const turn = await session.startTurn({ agentIds: ['agent-1'], messageId: 'msg-1', turnNumber: 1 });

      expect(turn).toBeInstanceOf(Turn);
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0]).toBe(turn);
    });

    it('emits turn.started event with sessionId and messageId', async () => {
      const session = new MakaioSession({ sessionId: 'sess-123', bus: MakaioBus });
      const received: unknown[] = [];

      const cleanup = MakaioBus.on(SessionSubjects.turn.started, (ctx) => {
        received.push(ctx.payload);
      });

      const turn = await session.startTurn({ agentIds: ['agent-1'], messageId: 'msg-1', turnNumber: 1 });

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        sessionId: 'sess-123',
        turnId: turn.turnId,
        agentIds: ['agent-1'],
        messageId: 'msg-1',
      });

      cleanup();
    });

    it('uses provided turnId if given', async () => {
      const session = new MakaioSession({ sessionId: 'sess-123', bus: MakaioBus });

      const turn = await session.startTurn({
        agentIds: ['agent-1'],
        messageId: 'msg-1',
        turnNumber: 1,
        turnId: 'custom-turn-id',
      });

      expect(turn.turnId).toBe('custom-turn-id');
    });

    it('rejects if session is closed', async () => {
      const session = new MakaioSession({ sessionId: 'sess-123', bus: MakaioBus });
      session.status = 'closed';

      await expect(session.startTurn({ agentIds: ['agent-1'], messageId: 'msg-1', turnNumber: 1 })).rejects.toThrow(
        'Cannot start turn on non-active session',
      );
    });
  });

  describe('getActiveTurn', () => {
    it('returns undefined when no turns exist', () => {
      const session = new MakaioSession({ sessionId: 'sess-123', bus: MakaioBus });

      expect(session.getActiveTurn()).toBeUndefined();
    });

    it('returns the last incomplete turn', async () => {
      const session = new MakaioSession({ sessionId: 'sess-123', bus: MakaioBus });
      const turn = await session.startTurn({ agentIds: ['agent-1'], messageId: 'msg-1', turnNumber: 1 });

      expect(session.getActiveTurn()).toBe(turn);
    });

    it('returns undefined after turn completes', async () => {
      const session = new MakaioSession({ sessionId: 'sess-123', bus: MakaioBus });
      const turn = await session.startTurn({ agentIds: ['agent-1'], messageId: 'msg-1', turnNumber: 1 });

      turn.markAgentCompleted('agent-1');
      await session.completeTurn(turn);

      expect(session.getActiveTurn()).toBeUndefined();
    });
  });

  describe('completeTurn', () => {
    it('emits turn.completed with success result', async () => {
      const session = new MakaioSession({ sessionId: 'sess-123', bus: MakaioBus });
      const turn = await session.startTurn({ agentIds: ['agent-1'], messageId: 'msg-1', turnNumber: 1 });
      const received: unknown[] = [];

      const cleanup = MakaioBus.on(SessionSubjects.turn.completed, (ctx) => {
        received.push(ctx.payload);
      });

      turn.markAgentCompleted('agent-1');
      await session.completeTurn(turn);

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        sessionId: 'sess-123',
        turnId: turn.turnId,
        success: true,
      });

      cleanup();
    });

    it('emits turn.completed with error result', async () => {
      const session = new MakaioSession({ sessionId: 'sess-123', bus: MakaioBus });
      const turn = await session.startTurn({ agentIds: ['agent-1'], messageId: 'msg-1', turnNumber: 1 });
      const received: unknown[] = [];

      const cleanup = MakaioBus.on(SessionSubjects.turn.completed, (ctx) => {
        received.push(ctx.payload);
      });

      turn.markAgentErrored('agent-1', 'Something went wrong');
      await session.completeTurn(turn);

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        sessionId: 'sess-123',
        turnId: turn.turnId,
        success: false,
        error: 'Something went wrong',
      });

      cleanup();
    });
  });
});
