import { describe, expect, it } from 'vitest';
import { DEFAULT_CONSTRAINTS } from '@makaio/contracts';
import { SubagentManager } from '../manager/index.js';

/** Create one running tracked subagent for completion reconciliation tests. */
function createManager(): SubagentManager {
  const manager = new SubagentManager(DEFAULT_CONSTRAINTS);
  manager.track({
    subagentId: 'sub-1',
    parentSessionId: 'parent-1',
    config: { task: 'test', adapterName: 'test-adapter', contextMode: 'fresh', completion: 'turn' },
    depth: 1,
  });
  manager.setChildSessionId('sub-1', 'child-1');
  manager.markStarted('sub-1');
  return manager;
}

describe('SubagentManager completion reconciliation', () => {
  it('projects only the currently active child turn', () => {
    const manager = createManager();

    manager.recordTurnStarted('child-1', 'turn-1');
    manager.recordTurnStarted('child-1', 'turn-2');
    manager.recordTurnCompleted('child-1', 'turn-1');
    expect(manager.get('sub-1')?.activeTurnId).toBe('turn-2');

    manager.recordTurnCompleted('child-1', 'turn-2');
    expect(manager.get('sub-1')?.activeTurnId).toBeUndefined();
  });

  it.each(['candidate-first', 'turn-first'] as const)('requires both proofs in %s order', (order) => {
    const manager = createManager();
    const candidate = () => manager.recordCompletionCandidate('sub-1', 'turn-1', 'done', undefined, 'turn');
    const turn = () =>
      manager.recordCompletedTurn('sub-1', 'turn-1', {
        total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 },
      });

    if (order === 'candidate-first') candidate();
    else turn();
    expect(manager.finalizeCompletionIfReady('sub-1')).toBe(false);
    if (order === 'candidate-first') turn();
    else candidate();

    expect(manager.finalizeCompletionIfReady('sub-1')).toBe(true);
    expect(manager.get('sub-1')).toMatchObject({
      status: 'completed',
      result: 'done',
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, toolCallCount: 0 },
    });
  });

  it('uses the canonical failed-turn verdict in either event order', () => {
    const manager = createManager();
    manager.recordCompletedTurn('sub-1', 'turn-1', undefined, false, 'provider failed');
    manager.recordCompletionCandidate('sub-1', 'turn-1', 'ignored', undefined, 'turn');

    expect(manager.finalizeCompletionIfReady('sub-1')).toBe(true);
    expect(manager.get('sub-1')).toMatchObject({ status: 'failed', error: 'provider failed' });
  });

  it('preserves completion intent while exposing stalled reconciliation as hung', () => {
    const manager = createManager();
    manager.recordCompletionCandidate('sub-1', 'turn-1', 'done', undefined, 'turn');

    expect(() =>
      manager.setPendingRequest('sub-1', {
        messageId: 'message-1',
        question: 'More input?',
        resolver: () => undefined,
      }),
    ).toThrow('completion is pending');
    manager.get('sub-1')!.lastActivityAt = 0;
    expect(manager.sweepHung(1)).toBe(1);
    expect(manager.get('sub-1')?.status).toBe('hung');
    manager.recordCompletedTurn('sub-1', 'turn-1', undefined);
    expect(manager.finalizeCompletionIfReady('sub-1')).toBe(true);
    expect(manager.get('sub-1')).toMatchObject({ status: 'completed', result: 'done' });
  });

  it('deduplicates tool observations and freezes the terminal economics snapshot', () => {
    const manager = createManager();
    manager.recordToolObservation('child-1', { toolName: 'read_file', outcome: 'success' }, 'tool-1');
    manager.recordToolObservation('child-1', { toolName: 'read_file', outcome: 'success' }, 'tool-1');
    manager.recordCompletionCandidate('sub-1', 'turn-1', 'done', undefined, 'turn');
    manager.recordCompletedTurn('sub-1', 'turn-1', undefined);
    manager.finalizeCompletionIfReady('sub-1');

    const tracked = manager.get('sub-1');
    expect(tracked?.toolObservations).toHaveLength(1);
    expect(tracked?.usage).toEqual({ toolCallCount: 1 });
    expect(Object.isFrozen(tracked?.usage)).toBe(true);
    expect(() => manager.recordCompletedTurn('sub-1', 'turn-1', undefined)).not.toThrow();
    expect(() => manager.recordCompletionCandidate('sub-1', 'turn-1', 'done', undefined, 'turn')).not.toThrow();
    expect(manager.finalizeCompletionIfReady('sub-1')).toBe(false);
    manager.recordToolObservation('child-1', { toolName: 'late_tool', outcome: 'success' }, 'tool-2');
    expect(tracked?.toolObservations).toHaveLength(1);
  });
});
