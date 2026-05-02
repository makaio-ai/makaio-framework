import { describe, expect, it, vi } from 'vitest';
import { MessageHandle, normalizeMessageInput } from '@makaio/ai-adapters-core';
import { createClaudeConnectorNamespace } from '../namespace/index.js';
import { ClaudeConnectorTurn } from './claude-connector-turn.js';

interface PauseResult {
  stateBeforePause: 'turn_finished';
  turnEnded: boolean;
}

/**
 * Creates a deterministic MessageHandle fixture for turn tests.
 *
 * Uses `normalizeMessageInput` to construct the message payload and returns a
 * `MessageHandle` bound to adapter session `session-1`.
 * @returns MessageHandle initialized with id `message-1`, content `hello`, and adapterSessionId `session-1`.
 */
function createMessageHandle(): MessageHandle {
  const handle = new MessageHandle('message-1', normalizeMessageInput('hello'), 'enqueue');
  handle.adapterSessionId = 'session-1';
  return handle;
}

describe('ClaudeConnectorTurn.finishOnError', () => {
  it('unblocks pause waiters and completes the turn without pausing', async () => {
    const namespace = createClaudeConnectorNamespace(
      `adapter:claude-turn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const bus = await namespace.scopedBus();
    const interrupt = vi.fn(async () => {});
    const turn = new ClaudeConnectorTurn(
      bus,
      namespace.subjects,
      'adapter-1',
      'claude-code',
      'agent-1',
      { interrupt },
      createMessageHandle(),
    );

    await turn.start();
    const pausePromise = turn.pause();
    await turn.finishOnError();

    const expectedPauseResult: PauseResult = {
      stateBeforePause: 'turn_finished',
      turnEnded: true,
    };
    await expect(pausePromise).resolves.toEqual(expectedPauseResult);
    expect(interrupt).not.toHaveBeenCalled();
    expect(turn.isCompleted()).toBe(true);
  });
});
