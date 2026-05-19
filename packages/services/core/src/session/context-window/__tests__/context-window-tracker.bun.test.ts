import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import { ContextWindowTracker } from '../context-window-tracker.js';

/**
 * Emits a context window update event with sensible defaults.
 * @param overrides - Fields to override on the default event payload
 */
function emitContextUpdate(
  overrides: Partial<{
    agentId: string;
    sessionId: string;
    currentTokens: number;
    maxTokens: number;
    percentage: number;
    level: 'ok' | 'warn' | 'critical';
  }> = {},
): Promise<void> {
  return MakaioBus.emit(AgentSubjects.contextWindow.updated, {
    agentId: overrides.agentId ?? 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'test',
    adapterSessionId: `adapter-session-${overrides.agentId ?? 'agent-1'}`,
    sessionId: overrides.sessionId,
    currentTokens: overrides.currentTokens ?? 50000,
    maxTokens: overrides.maxTokens ?? 100000,
    percentage: overrides.percentage ?? 50,
    level: overrides.level ?? 'ok',
  });
}

/** Short delay to allow async event processing. */
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('ContextWindowTracker', () => {
  let tracker: ContextWindowTracker;

  beforeEach(() => {
    tracker = new ContextWindowTracker(MakaioBus);
    tracker.start();
  });

  afterEach(() => {
    tracker.stop();
  });

  describe('basic tracking', () => {
    it('tracks context window updates by session', async () => {
      await emitContextUpdate({ sessionId: 'session-1' });
      await tick();

      const state = tracker.getSessionState('session-1');
      expect(state).toBeDefined();
      expect(state?.currentTokens).toBe(50000);
      expect(state?.maxTokens).toBe(100000);
      expect(state?.percentage).toBe(50);
      expect(state?.level).toBe('ok');
      expect(state?.worstAgentId).toBe('agent-1');
    });

    it('returns undefined for unknown session', () => {
      const state = tracker.getSessionState('unknown');
      expect(state).toBeUndefined();
    });

    it('ignores events without sessionId', async () => {
      await emitContextUpdate(); // No sessionId
      await tick();

      const state = tracker.getSessionState('session-1');
      expect(state).toBeUndefined();
    });
  });

  describe('worst agent aggregation', () => {
    it('aggregates to worst agent state', async () => {
      await emitContextUpdate({ sessionId: 'session-1', percentage: 50 });
      await emitContextUpdate({
        agentId: 'agent-2',
        sessionId: 'session-1',
        currentTokens: 80000,
        percentage: 80,
        level: 'critical',
      });
      await tick();

      const state = tracker.getSessionState('session-1');
      expect(state?.percentage).toBe(80);
      expect(state?.level).toBe('critical');
      expect(state?.worstAgentId).toBe('agent-2');
    });

    it('updates when agent improves', async () => {
      await emitContextUpdate({
        sessionId: 'session-1',
        currentTokens: 80000,
        percentage: 80,
        level: 'critical',
      });
      await tick();
      expect(tracker.getSessionState('session-1')?.percentage).toBe(80);

      await emitContextUpdate({
        sessionId: 'session-1',
        currentTokens: 20000,
        percentage: 20,
        level: 'ok',
      });
      await tick();
      expect(tracker.getSessionState('session-1')?.percentage).toBe(20);
      expect(tracker.getSessionState('session-1')?.level).toBe('ok');
    });
  });

  describe('session lifecycle', () => {
    it('clearSession removes session state', async () => {
      await emitContextUpdate({ sessionId: 'session-1' });
      await tick();
      expect(tracker.getSessionState('session-1')).toBeDefined();

      tracker.clearSession('session-1');
      expect(tracker.getSessionState('session-1')).toBeUndefined();
    });

    it('stop() clears all state and unsubscribes', async () => {
      await emitContextUpdate({ sessionId: 'session-1' });
      await tick();
      expect(tracker.getSessionState('session-1')).toBeDefined();

      tracker.stop();
      expect(tracker.getSessionState('session-1')).toBeUndefined();

      // Further events should not be tracked
      await emitContextUpdate({ agentId: 'agent-2', sessionId: 'session-2' });
      await tick();
      expect(tracker.getSessionState('session-2')).toBeUndefined();
    });

    it('start() is idempotent', () => {
      expect(() => tracker.start()).not.toThrow();
    });
  });

  describe('stale agent handling', () => {
    it('ignores stale agent data when computing session state', async () => {
      tracker.stop();
      tracker = new ContextWindowTracker(MakaioBus, { staleThresholdMs: 50 });
      tracker.start();

      await emitContextUpdate({
        sessionId: 'session-1',
        currentTokens: 90000,
        percentage: 90,
        level: 'critical',
      });
      await tick();

      // Wait for agent-1 to become stale
      await new Promise((r) => setTimeout(r, 60));

      await emitContextUpdate({
        agentId: 'agent-2',
        sessionId: 'session-1',
        currentTokens: 30000,
        percentage: 30,
        level: 'ok',
      });
      await tick();

      const state = tracker.getSessionState('session-1');
      expect(state?.percentage).toBe(30);
      expect(state?.worstAgentId).toBe('agent-2');
    });
  });

  describe('multi-session isolation', () => {
    it('tracks separate sessions independently', async () => {
      await emitContextUpdate({ sessionId: 'session-1', percentage: 50 });
      await emitContextUpdate({
        agentId: 'agent-2',
        sessionId: 'session-2',
        currentTokens: 80000,
        percentage: 80,
        level: 'critical',
      });
      await tick();

      expect(tracker.getSessionState('session-1')?.percentage).toBe(50);
      expect(tracker.getSessionState('session-2')?.percentage).toBe(80);
    });

    it('clearSession only affects target session', async () => {
      await emitContextUpdate({ sessionId: 'session-1' });
      await emitContextUpdate({
        agentId: 'agent-2',
        sessionId: 'session-2',
        currentTokens: 80000,
        percentage: 80,
        level: 'critical',
      });
      await tick();

      tracker.clearSession('session-1');
      expect(tracker.getSessionState('session-1')).toBeUndefined();
      expect(tracker.getSessionState('session-2')).toBeDefined();
    });
  });
});
